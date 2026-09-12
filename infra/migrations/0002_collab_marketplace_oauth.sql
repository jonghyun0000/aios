-- 0002: 실시간 협업 / 마켓플레이스 / OAuth / 결제 멱등성
--
-- 0001에서 빠져 있던 것을 채운다. 왜 지금인가:
--  - collab: 문서 상태가 메모리에만 있으면 서버 재시작 = 데이터 손실.
--  - oauth: 0001은 Supabase Auth에 위임한다고 적었지만, 자체 OAuth 코드 교환 경로가 없어
--           Supabase를 쓰지 않는 배포에서는 로그인 수단이 아예 없었다.
--  - marketplace: plugins 테이블은 있었지만 게시/설치를 수행할 서버 측 상태(다운로드 수,
--                 평점, 게시 감사 로그)가 없어 "레지스트리"라 부를 수 없었다.
--  - stripe_events: 웹훅은 최소 1회 전달(at-least-once)이다. 멱등 처리가 없으면
--                   같은 구독 변경이 두 번 반영될 수 있다.

-- ---------- Realtime collaboration ----------

create table collab_docs (
  org_id     uuid not null references organizations(id) on delete cascade,
  doc_id     text not null,
  -- Yjs 상태 스냅샷(바이너리). 텍스트로 풀어 저장하지 않는 이유는 CRDT 병합 이력을
  -- 잃으면 재접속 시 충돌 해결이 불가능해지기 때문.
  state      bytea not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, doc_id)
);

create index collab_docs_updated_idx on collab_docs (org_id, updated_at desc);

-- ---------- OAuth ----------

-- 진행 중인 authorization code flow. state/PKCE verifier를 서버가 보관해야
-- CSRF(state 위조)와 코드 가로채기(PKCE)를 동시에 막을 수 있다.
create table oauth_states (
  state          text primary key,
  provider       text not null,
  code_verifier  text not null,
  redirect_to    text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

create index oauth_states_expiry_idx on oauth_states (expires_at);

-- 외부 IdP 계정 ↔ 내부 user 연결. 같은 사람이 GitHub와 Google을 모두 연결할 수 있으므로
-- (provider, provider_account_id)가 유일 키이고 user_id는 중복 가능.
create table oauth_accounts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  provider            text not null,
  provider_account_id text not null,
  email               text,
  -- access_token은 저장하지 않는다. 우리는 로그인 확인 후 자체 세션을 발급하며,
  -- IdP API를 대신 호출하지 않으므로 토큰을 보관할 이유가 없다(유출 시 피해만 커진다).
  created_at          timestamptz not null default now(),
  last_login_at       timestamptz not null default now(),
  unique (provider, provider_account_id)
);

create index oauth_accounts_user_idx on oauth_accounts (user_id);

-- 자체 발급 세션 토큰. 토큰 원문이 아니라 sha256 해시를 저장한다 —
-- DB가 유출돼도 세션을 탈취당하지 않도록.
create table auth_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  user_agent  text,
  ip          inet,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create index auth_sessions_user_idx on auth_sessions (user_id, created_at desc);
create index auth_sessions_expiry_idx on auth_sessions (expires_at);

-- ---------- Marketplace ----------

alter table plugins add column if not exists downloads bigint not null default 0;
alter table plugins add column if not exists keywords text[] not null default '{}';
alter table plugins add column if not exists homepage text;
alter table plugins add column if not exists updated_at timestamptz not null default now();

-- 검색용 전문 인덱스. generated column으로 두면 애플리케이션이 갱신을 잊을 수 없다.
alter table plugins add column if not exists tsv tsvector
  generated always as (
    to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(slug,'') || ' ' || coalesce(description,''))
  ) stored;

create index if not exists plugins_tsv_idx on plugins using gin (tsv);
create index if not exists plugins_downloads_idx on plugins (downloads desc);

create table plugin_ratings (
  plugin_id  uuid not null references plugins(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  rating     int not null check (rating between 1 and 5),
  comment    text,
  created_at timestamptz not null default now(),
  primary key (plugin_id, user_id)
);

-- 게시 이력. 누가 언제 어떤 번들을 올렸는지 남기지 않으면 악성 버전 사후 추적이 불가능하다.
create table plugin_publish_events (
  id         bigserial primary key,
  plugin_id  uuid not null references plugins(id) on delete cascade,
  version_id uuid references plugin_versions(id) on delete set null,
  actor_id   uuid references users(id) on delete set null,
  action     text not null check (action in ('publish','approve','reject','yank')),
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index plugin_publish_events_plugin_idx on plugin_publish_events (plugin_id, created_at desc);

-- ---------- Billing ----------

-- 웹훅 멱등성. Stripe는 같은 이벤트를 여러 번 보낼 수 있다(at-least-once).
create table stripe_events (
  id           text primary key,      -- Stripe event id (evt_...)
  type         text not null,
  processed_at timestamptz not null default now()
);

alter table subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table subscriptions add column if not exists updated_at timestamptz not null default now();
