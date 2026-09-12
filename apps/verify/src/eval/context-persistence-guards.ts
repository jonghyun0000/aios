export function localPersistenceEndpoints(env: Record<string, string | undefined>): { base: string; database: string; redis: string } {
  if (env.AIOS_CONTEXT_PERSISTENCE_TEST !== "1") throw new Error("AIOS_CONTEXT_PERSISTENCE_TEST=1로 새 합성 대화 생성 시험을 명시해야 합니다.");
  const parse = (raw: string | undefined, protocols: string[]) => {
    let url: URL;
    try { if (!raw) throw new Error(); url = new URL(raw); } catch { throw new Error("로컬 통합 시험 연결 설정이 필요합니다. 값은 출력하지 않습니다."); }
    if (!protocols.includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("이 시험은 loopback 서비스만 사용합니다.");
    // pg의 ?host=는 URL hostname을 덮어쓸 수 있다. SSL 파일 옵션 등 드라이버별 우회도 허용하지 않는다.
    if (url.search || url.hash) throw new Error("시험 연결 주소의 추가 쿼리·fragment 옵션은 허용하지 않습니다.");
    return url;
  };
  const base = parse(env.AIOS_BASE_URL ?? "http://127.0.0.1:8791", ["http:"]);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("API 주소는 인증정보·경로·쿼리가 없는 로컬 원점이어야 합니다.");
  const database = parse(env.DATABASE_URL, ["postgres:", "postgresql:"]);
  const redis = parse(env.REDIS_URL, ["redis:"]);
  return { base: base.origin, database: database.href, redis: redis.href };
}
