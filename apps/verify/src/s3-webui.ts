/**
 * Sprint #3 Phase E — 웹 UI 서빙 검증.
 *
 * 브라우저 상호작용(로그인, 협업 두 탭 동기화, 설치, 채팅 스트리밍)은 실제 브라우저로
 * 직접 확인했고 그 결과는 docs/13-web-ui.md에 기록했다. 여기서는 **자동으로 반복 가능한**
 * 계층만 검증한다: 번들이 서빙되는가, 헤더가 맞는가, 라우팅 경계가 지켜지는가.
 *
 * 특히 중요한 것은 "정적 UI에 인증을 걸지 않는다"이다.
 * UI를 처음 붙였을 때 전역 인증 훅이 `/` 까지 가로채 로그인 화면 자체를 받을 수 없었다 —
 * 아무도 로그인할 수 없는 상태였고, 이 검사가 그 재발을 막는다.
 */
import { Report } from "./report.js";

const BASE = process.env.AIOS_BASE_URL ?? "http://127.0.0.1:8787";
const KEY = process.env.AIOS_API_KEY;

const report = new Report("Sprint#3 Phase E — 웹 UI 서빙");

async function fetchRaw(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "manual" });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

report.section("E.1 번들 서빙");

let assetPath = "";

await report.guard("루트가 SPA HTML을 반환한다 (인증 없이)", async () => {
  const r = await fetchRaw("/");
  report.check("200 OK", r.status === 200, `status=${r.status}`);
  report.check("HTML 문서", r.headers.get("content-type")?.includes("text/html") === true,
    r.headers.get("content-type") ?? "");
  report.check("루트 엘리먼트 포함", r.body.includes('id="root"'), "");
  report.check("모듈 스크립트 참조", /<script[^>]+type="module"/.test(r.body), "");
  const m = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(r.body);
  assetPath = m?.[0] ?? "";
  report.check("해시 붙은 자산 참조", assetPath.length > 0, assetPath);
});

await report.guard("index.html은 캐시되지 않는다", async () => {
  const r = await fetchRaw("/");
  // 캐시되면 새 배포가 사용자에게 영영 도달하지 않는다.
  report.check("cache-control: no-cache", r.headers.get("cache-control") === "no-cache",
    r.headers.get("cache-control") ?? "없음");
});

await report.guard("해시 자산은 영구 캐시된다", async () => {
  if (!assetPath) throw new Error("자산 경로를 찾지 못했다");
  const r = await fetchRaw(assetPath);
  report.check("200 OK", r.status === 200, `status=${r.status}`);
  report.check("immutable 캐시", r.headers.get("cache-control")?.includes("immutable") === true,
    r.headers.get("cache-control") ?? "없음");
  report.check("JS 콘텐츠 타입", r.headers.get("content-type")?.includes("javascript") === true,
    r.headers.get("content-type") ?? "");
});

report.section("E.2 라우팅 경계");

await report.guard("알 수 없는 UI 경로는 SPA로 fallback", async () => {
  const r = await fetchRaw("/billing");
  report.check("200 + HTML", r.status === 200 && r.body.includes('id="root"'), `status=${r.status}`);
});

await report.guard("알 수 없는 API 경로는 HTML이 아니라 JSON 404", async () => {
  if (!KEY) throw new Error("AIOS_API_KEY 필요");
  const r = await fetchRaw("/v1/definitely-not-a-route", { authorization: `Bearer ${KEY}` });
  report.check("404", r.status === 404, `status=${r.status}`);
  // HTML을 돌려주면 클라이언트가 JSON 파싱에 실패해 엉뚱한 에러를 보게 된다.
  report.check("JSON 응답", r.headers.get("content-type")?.includes("json") === true,
    r.headers.get("content-type") ?? "");
  report.check("에러 코드 포함", r.body.includes("not_found"), r.body.slice(0, 120));
});

await report.guard("보호된 API는 여전히 401", async () => {
  const r = await fetchRaw("/v1/me");
  report.check("401", r.status === 401, `status=${r.status}`);
});

await report.guard("로그인에 필요한 공개 엔드포인트는 인증 없이 열린다", async () => {
  const r = await fetchRaw("/v1/auth/providers");
  report.check("200", r.status === 200, `status=${r.status}`);
  report.check("providers 배열", r.body.includes("providers"), r.body.slice(0, 100));
});

report.section("E.3 반응형 CSS");

await report.guard("모바일 미디어 쿼리가 번들에 포함돼 있다", async () => {
  // 사이드바가 232px 고정이면 375px 기기에서 화면의 62%를 먹고 본문이 눌린다.
  // CSS가 빌드에서 누락되면 화면으로만 알 수 있으므로 여기서 존재를 고정한다.
  const html = await fetchRaw("/");
  const css = /\/assets\/[A-Za-z0-9._-]+\.css/.exec(html.body)?.[0];
  report.check("CSS 자산 참조", !!css, css ?? "없음");
  if (!css) return;
  const r = await fetchRaw(css);
  report.check("max-width 미디어 쿼리 존재", /@media[^{]*max-width/.test(r.body), "");
  report.check("사이드바가 1열로 접힌다", /grid-template-columns:\s*1fr/.test(r.body), "");
  report.check("표 가로 스크롤", /overflow-x:\s*auto/.test(r.body), "");
});

report.section("E.4 접근성");

await report.guard("접근성 CSS가 번들에 있다", async () => {
  const html = await fetchRaw("/");
  const css = /\/assets\/[A-Za-z0-9._-]+\.css/.exec(html.body)?.[0];
  if (!css) throw new Error("CSS 자산을 찾지 못했다");
  const r = await fetchRaw(css);
  // 버튼·링크에 포커스 표시가 없으면 키보드 사용자는 자기 위치를 알 수 없다.
  // 실측으로 outline:none 상태였던 것을 고쳤으므로 회귀를 막는다.
  report.check(":focus-visible 규칙", /:focus-visible/.test(r.body), "");
  // :focus 로만 처리하면 마우스 클릭에도 테두리가 남아 결국 outline:none 으로 되돌리게 된다.
  report.check("skip link 스타일", /\.skip-link/.test(r.body), "");
  report.check("sr-only 유틸리티", /\.sr-only/.test(r.body), "");
  report.check("prefers-reduced-motion 대응", /prefers-reduced-motion/.test(r.body), "");
});

await report.guard("aria 속성이 번들에 있다", async () => {
  const html = await fetchRaw("/");
  const js = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(html.body)?.[0];
  if (!js) throw new Error("JS 자산을 찾지 못했다");
  const r = await fetchRaw(js);
  // placeholder는 라벨이 아니다 — 입력을 시작하면 사라진다.
  // 실측에서 라벨 없는 필드가 9개였고 전부 aria-label 로 채웠다.
  const labels = (r.body.match(/aria-label/g) ?? []).length;
  report.check("aria-label 다수 존재", labels >= 8, `${labels}개`);
  report.check("현재 페이지 표시(aria-current)", /aria-current/.test(r.body), "");
  // 선 그래프는 스크린리더에 아무 정보도 주지 못하므로 role=img + 요약이 필요하다.
  report.check("차트에 role=img", /role:"img"|role="img"/.test(r.body), "");
  report.check("본문 바로가기 문구", /본문으로 건너뛰기/.test(r.body), "");
});

report.section("E.5 번들 내용");

await report.guard("번들에 비밀이 섞여 들어가지 않았다", async () => {
  if (!assetPath) throw new Error("자산 경로를 찾지 못했다");
  const r = await fetchRaw(assetPath);
  // 프론트엔드 번들은 공개물이다. 빌드 시 환경변수가 인라인되는 실수를 잡는다.
  const leaks = [
    ["Anthropic 키", /sk-ant-api[0-9]{2}-/],
    ["OpenAI 키", /sk-proj-[A-Za-z0-9_-]{20}/],
    ["Stripe 시크릿", /sk_(live|test)_[A-Za-z0-9]{16}/],
    ["AIOS API 키", /aios_live_[A-Za-z0-9_-]{16}/],
    ["Postgres URL", /postgres(ql)?:\/\/[^\s"']+:[^\s"']+@/],
  ] as const;
  for (const [name, pattern] of leaks) {
    report.check(`${name} 미포함`, !pattern.test(r.body), pattern.test(r.body) ? "발견됨!" : "");
  }
});

await report.guard("번들 크기가 합리적이다", async () => {
  if (!assetPath) throw new Error("자산 경로를 찾지 못했다");
  const r = await fetchRaw(assetPath);
  const kb = Math.round(r.body.length / 1024);
  // 상한을 두는 이유: 실수로 무거운 의존성이 들어오면 초기 로딩이 조용히 나빠진다.
  report.check("< 600KB (비압축)", kb < 600, `${kb}KB`);
});

report.finish();
