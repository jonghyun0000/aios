-- AIOS initial schema
-- 설계 원칙:
--  1) 멀티테넌시 기준 축은 organization. 모든 리소스는 org_id로 격리 (RLS 적용 가능).
--  2) 벡터는 pgvector(HNSW) — 별도 벡터DB 없이 트랜잭션/조인/백업을 Postgres 하나로 통일.
--  3) 고빈도 append-only 테이블(usage_events, audit_logs)은 bigserial + BRIN 지향, 파티셔닝은 스케일 단계에서.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------- Identity / Tenancy ----------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

-- users.id 는 Supabase auth.users.id 를 미러링 (OAuth는 Supabase Auth가 담당)
create table users (
  id           uuid primary key,
  email        text not null unique,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create type org_role as enum ('owner', 'admin', 'member', 'viewer');

create table org_members (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table projects (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  name           text not null,
  repo_url       text,
  default_branch text not null default 'main',
  settings       jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index projects_org_idx on projects (org_id);

-- API 키는 해시만 저장. prefix는 UI 표시용.
create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,          -- sha256(hex)
  key_prefix   text not null,                 -- e.g. "aios_live_ab12"
  scopes       text[] not null default '{}',
  last_used_at timestamptz,
  expires_at   timestamptz,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now()
);
create index api_keys_org_idx on api_keys (org_id);

-- ---------- Conversation ----------

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  user_id    uuid references users(id),          -- null = 기계 주체(API 키) 세션
  title      text,
  status     text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sessions_org_user_idx on sessions (org_id, user_id, updated_at desc);

create type message_role as enum ('system', 'user', 'assistant', 'tool');

create table messages (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id) on delete cascade,
  role          message_role not null,
  content       jsonb not null,               -- normalized content blocks
  provider      text,
  model         text,
  input_tokens  int,
  output_tokens int,
  latency_ms    int,
  created_at    timestamptz not null default now()
);
create index messages_session_idx on messages (session_id, created_at);

create table tool_invocations (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references sessions(id) on delete cascade,
  message_id  uuid references messages(id) on delete set null,
  tool_name   text not null,
  arguments   jsonb not null,
  result      jsonb,
  status      text not null check (status in ('ok','error','denied','timeout')),
  sandboxed   boolean not null default false,
  duration_ms int,
  created_at  timestamptz not null default now()
);
create index tool_invocations_session_idx on tool_invocations (session_id, created_at);

-- ---------- Memory (Long-term) ----------

create table memory_items (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  user_id           uuid references users(id) on delete cascade,     -- null = org 공유 메모리
  project_id        uuid references projects(id) on delete cascade,  -- null = 프로젝트 무관
  kind              text not null check (kind in ('fact','preference','decision','summary')),
  content           text not null,
  embedding         vector(1536),
  importance        real not null default 0.5 check (importance between 0 and 1),
  access_count      int not null default 0,
  last_accessed_at  timestamptz,
  source_session_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index memory_items_scope_idx on memory_items (org_id, user_id, project_id);
create index memory_items_embedding_idx on memory_items
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ---------- Codebase Index (RAG) ----------

create table code_files (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  path        text not null,
  content_sha text not null,                  -- 파일 단위 증분 인덱싱의 비교 키
  lang        text,
  size_bytes  int not null default 0,
  indexed_at  timestamptz not null default now(),
  unique (project_id, path)
);

create table code_chunks (
  id         uuid primary key default gen_random_uuid(),
  file_id    uuid not null references code_files(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  start_line int not null,
  end_line   int not null,
  symbol     text,
  content    text not null,
  embedding  vector(1536),
  tsv        tsvector generated always as (to_tsvector('simple', content)) stored
);
create index code_chunks_project_idx on code_chunks (project_id);
create index code_chunks_embedding_idx on code_chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index code_chunks_tsv_idx on code_chunks using gin (tsv);

-- ---------- Plugins / Marketplace ----------

create table plugins (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text,
  author_org  uuid references organizations(id) on delete set null,
  visibility  text not null default 'public' check (visibility in ('public','private','unlisted')),
  created_at  timestamptz not null default now()
);

create table plugin_versions (
  id            uuid primary key default gen_random_uuid(),
  plugin_id     uuid not null references plugins(id) on delete cascade,
  version       text not null,
  manifest      jsonb not null,
  bundle_url    text not null,
  bundle_sha256 text not null,
  signature     text,                          -- ed25519(base64) over sha256
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at    timestamptz not null default now(),
  unique (plugin_id, version)
);

create table plugin_installs (
  org_id              uuid not null references organizations(id) on delete cascade,
  plugin_id           uuid not null references plugins(id) on delete cascade,
  version_id          uuid not null references plugin_versions(id),
  enabled             boolean not null default true,
  granted_permissions text[] not null default '{}',
  installed_by        uuid references users(id),
  created_at          timestamptz not null default now(),
  primary key (org_id, plugin_id)
);

-- ---------- Billing ----------

create table plans (
  id                  text primary key,        -- 'free' | 'pro' | 'team' | 'enterprise'
  name                text not null,
  monthly_price_cents int not null default 0,
  included_tokens     bigint not null default 0,
  limits              jsonb not null default '{}'
);

create table subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null unique references organizations(id) on delete cascade,
  plan_id                text not null references plans(id),
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text not null default 'active',
  current_period_end     timestamptz,
  created_at             timestamptz not null default now()
);

create table usage_events (
  id            bigserial primary key,
  org_id        uuid not null,
  user_id       uuid,
  session_id    uuid,
  kind          text not null check (kind in ('chat','embedding','tool','index')),
  provider      text,
  model         text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cost_usd      numeric(12, 6) not null default 0,
  created_at    timestamptz not null default now()
);
create index usage_events_org_time_idx on usage_events (org_id, created_at);

-- ---------- Audit ----------

create table audit_logs (
  id          bigserial primary key,
  org_id      uuid,
  actor_id    uuid,
  action      text not null,                   -- e.g. 'tool.exec', 'plugin.install'
  target_type text,
  target_id   text,
  metadata    jsonb not null default '{}',
  ip          inet,
  created_at  timestamptz not null default now()
);
create index audit_logs_org_time_idx on audit_logs (org_id, created_at);

-- ---------- Seed ----------

insert into plans (id, name, monthly_price_cents, included_tokens, limits) values
  ('free', 'Free',       0,       2000000,   '{"projects":1,"index_files":2000,"rpm":20}'),
  ('pro',  'Pro',        2000,    30000000,  '{"projects":10,"index_files":50000,"rpm":120}'),
  ('team', 'Team',       6000,    120000000, '{"projects":100,"index_files":500000,"rpm":600}')
on conflict (id) do nothing;

-- ---------- RLS (Supabase 직결 시 활성화; API 서버가 service role로 접근하는 경우는 앱 계층에서 org 격리) ----------
-- auth.uid()는 Supabase 전용 함수이므로, auth 스키마가 존재할 때만 정책을 생성한다.
-- (셀프호스팅/로컬 Postgres에서도 동일 마이그레이션이 그대로 적용되게 하기 위함)

alter table memory_items enable row level security;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    execute $pol$
      create policy memory_isolation on memory_items
        using (org_id in (select org_id from org_members where user_id = auth.uid()))
    $pol$;
  end if;
end $$;
