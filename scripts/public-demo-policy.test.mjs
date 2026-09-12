import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateDemoPolicy } from "./public-demo-policy.mjs";

const policy = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
test("공개 데모는 정적 출력과 외부 연결 차단 정책을 사용한다", () => {
  assert.equal(validateDemoPolicy(policy)["x-frame-options"], "DENY");
});
test("결함 주입: 앱 출력/서버 함수/프록시로 변경하면 실패한다", () => {
  for (const change of [{ outputDirectory: "apps/web/dist" }, { functions: {} }, { rewrites: [{ source: "/v1/(.*)", destination: "https://example.com" }] }]) assert.throws(() => validateDemoPolicy({ ...policy, ...change }));
});
test("결함 주입: 연결 허용과 인라인/평가 실행 또는 CSP 누락을 검출한다", () => {
  for (const [from, to] of [["connect-src 'none'", "connect-src *"], ["script-src 'self'", "script-src 'self' 'unsafe-eval'"], ["style-src 'self'", "style-src 'self' 'unsafe-inline'"], ["form-action 'none'", "form-action 'self'"], ["frame-ancestors 'none'", ""]]) {
    const changed = structuredClone(policy);
    const csp = changed.headers[0].headers.find(item => item.key === "Content-Security-Policy");
    csp.value = csp.value.replace(from, to);
    assert.throws(() => validateDemoPolicy(changed), from);
  }
  assert.throws(() => validateDemoPolicy({ ...policy, headers: [] }));
});
