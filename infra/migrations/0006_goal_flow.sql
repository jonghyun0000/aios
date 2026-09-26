-- 5-4 (docs/42): 실행 기록을 사용자의 목표에 묶고, 이어서 한 실행을 원래 실행에 연결한다.
-- 추가만 한다. 기존 행은 goal·resumed_from 이 비어 있으며 화면은 "목표 기록 없음"으로 보여 준다.
alter table execution_runs add column goal text check (goal is null or char_length(goal) <= 2000);
alter table execution_runs add column resumed_from uuid references execution_runs(id);
create index execution_runs_resumed_from_idx on execution_runs (resumed_from) where resumed_from is not null;
