-- 0003: API 키에 역할을 부여한다.
--
-- 결함: authenticateApiKey가 role을 'member'로 하드코딩하고 있었다.
-- 그 결과 requireRole('admin') 이상을 요구하는 모든 작업 — 플러그인 설치,
-- 마켓플레이스 게시, 결제 Checkout — 을 API 키로는 영원히 수행할 수 없었다.
-- CLI/CI/SDK가 전부 API 키를 쓰므로, 사실상 "사람이 브라우저로만 할 수 있는" 기능이 됐다.
--
-- 왜 scopes로 해결하지 않는가: scopes는 '어떤 엔드포인트를 부를 수 있는가'이고
-- role은 '조직 안에서 어떤 권한 수준인가'다. 둘을 섞으면 role 기반 RBAC 검사와
-- scope 기반 검사가 서로 다른 답을 내는 순간을 만들 수 있다.
--
-- 기본값을 'member'로 두는 이유: 기존 키의 권한이 마이그레이션만으로 올라가면 안 된다.
-- 승격은 명시적 행위여야 한다.

alter table api_keys add column if not exists role org_role not null default 'member';

comment on column api_keys.role is
  '이 키가 조직 내에서 갖는 최대 권한. 사람 계정의 role을 넘을 수 없도록 발급 시 검증한다.';
