create table execution_runs (
  id uuid primary key,
  org_id uuid not null references organizations(id),
  session_id uuid not null references sessions(id),
  workspace_root text not null,
  status text not null default 'running',
  verification_command text,
  summary text not null default '',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index execution_runs_session_idx on execution_runs (session_id, created_at desc);
create table execution_actions (
  id uuid primary key,
  run_id uuid not null references execution_runs(id),
  tool_name text not null,
  arguments jsonb not null,
  purpose text not null default 'tool',
  status text not null,
  output text not null default '',
  exit_code integer,
  before_hash text,
  after_hash text,
  preview jsonb,
  checkpoint boolean not null default false,
  expires_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  restored_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index execution_actions_run_idx on execution_actions (run_id, created_at, id);
