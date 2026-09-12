-- 원본 메시지는 삭제하지 않는다. 휴지통 복구와 캐시 없는 맥락 복구의 원본이다.
alter table sessions add column deleted_at timestamptz;
create index sessions_live_page_idx on sessions (org_id, updated_at desc, id desc) where deleted_at is null;

-- 작은 UTF-8 참고자료만 저장한다. 실행 파일이나 호스트 경로를 받지 않는다.
create table workspace_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  name text not null,
  content text not null check (octet_length(content) <= 65536),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((session_id is null) <> (project_id is null))
);
create index workspace_files_session_idx on workspace_files (session_id) where deleted_at is null;
create index workspace_files_project_idx on workspace_files (project_id) where deleted_at is null;
