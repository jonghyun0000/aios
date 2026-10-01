import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPrebuiltOutput, validateDemoPolicy, validateDeployWorkflow } from "./public-demo-policy.mjs";

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

const workflow = await readFile(new URL("../.github/workflows/deploy-demo.yml", import.meta.url), "utf8");
test("배포 워크플로는 승인 게이트·최소 권한·토큰 격리·배포 후 공개 주소 검증을 갖춘다", () => {
  assert.deepEqual(validateDeployWorkflow(workflow), { environment: "demo-production", url: "https://aios-demo-mu.vercel.app" });
});
test("결함 주입: 배포 워크플로의 안전 경계를 하나씩 깨면 실패한다", () => {
  const faults = [
    ["승인 Environment 제거", /승인 Environment/, (t) => t.replace("    environment:\n      name: demo-production\n", "")],
    ["Environment 이름 변경", /승인 Environment/, (t) => t.replace("name: demo-production", "name: production")],
    ["쓰기 권한", /contents: read/, (t) => t.replace("  contents: read", "  contents: write")],
    ["PR 트리거", /PR 트리거/, (t) => t.replace("on:\n", "on:\n  pull_request:\n")],
    ["포크 PR 트리거", /PR 트리거/, (t) => t.replace("on:\n", "on:\n  pull_request_target:\n")],
    ["경로 제한 없는 push", /체험판 경로/, (t) => t.replace(/ {4}paths:\n(?: {6}.*\n)+/, "")],
    ["main 외 브랜치", /main으로/, (t) => t.replace("branches: [main]", "branches: ['**']")],
    ["수동 실행 제거", /workflow_dispatch/, (t) => t.replace("  workflow_dispatch:\n", "")],
    ["verify 의존 제거", /verify 잡 뒤/, (t) => t.replace("    needs: verify\n", "")],
    ["검사 잡에 토큰 노출", /deploy 잡에만/, (t) => t.replace("      - run: pnpm build:demo\n", "      - run: pnpm build:demo\n        env:\n          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}\n")],
    ["전역 토큰", /전역/, (t) => t.replace("permissions:\n", "env:\n  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}\n\npermissions:\n")],
    ["CLI 버전 미고정", /CLI 버전/, (t) => t.replace("vercel@62.1.0", "vercel@latest")],
    ["액션 태그 고정", /커밋 SHA/, (t) => t.replace("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v4")],
    ["서버 재빌드 배포", /deploy --prebuilt/, (t) => t.replace("deploy --prebuilt --prod", "deploy --prod")],
    ["업로드 감사 생략", /check-vercel-output/, (t) => t.replace("        run: node scripts/check-vercel-output.mjs\n", "        run: echo skipped\n")],
    ["배포 후 검증 생략", /공개 Production/, (t) => t.replace("AIOS_DEMO_URL: https://aios-demo-mu.vercel.app", "AIOS_DEMO_URL: \"\"")],
    ["감사보다 배포가 먼저", /deploy --prebuilt/, (t) => t.replace("deploy --prebuilt --prod", "PLACEHOLDER").replace("node scripts/check-vercel-output.mjs", "pnpm dlx \"$VERCEL_CLI\" deploy --prebuilt --prod").replace("PLACEHOLDER", "echo late-audit node scripts/check-vercel-output.mjs")],
    ["진행 중 배포 취소", /취소/, (t) => t.replace("cancel-in-progress: false", "cancel-in-progress: true")],
  ];
  for (const [name, reason, inject] of faults) {
    const changed = inject(workflow);
    assert.notEqual(changed, workflow, `주입이 적용되지 않음: ${name}`);
    assert.throws(() => validateDeployWorkflow(changed), reason, name);
  }
});

async function prebuiltFixture() {
  const root = await mkdtemp(join(tmpdir(), "aios-demo-output-"));
  await writeFile(join(root, "vercel.json"), JSON.stringify(policy));
  const dist = join(root, "apps/demo/dist"); const assets = join(dist, "assets");
  const statics = join(root, ".vercel/output/static"); const staticAssets = join(statics, "assets");
  for (const dir of [assets, staticAssets]) await mkdir(dir, { recursive: true });
  for (const base of [dist, statics]) {
    await writeFile(join(base, "index.html"), "<!doctype html><title>demo</title>");
    await writeFile(join(base, "assets/app.js"), "console.log('demo')");
  }
  await writeFile(join(root, ".vercel/output/config.json"), JSON.stringify({ version: 3, routes: [] }));
  return root;
}
test("업로드 대상이 감사한 빌드와 같으면 통과하고, 다르면 실패한다", async () => {
  const root = await prebuiltFixture();
  try {
    assert.equal((await checkPrebuiltOutput(root)).files, 2);
    await writeFile(join(root, ".vercel/output/static/assets/app.js"), "console.log('changed')");
    await assert.rejects(checkPrebuiltOutput(root), /다릅니다/);
    await writeFile(join(root, ".vercel/output/static/assets/app.js"), "console.log('demo')");
    await writeFile(join(root, ".vercel/output/static/extra.js"), "1");
    await assert.rejects(checkPrebuiltOutput(root), /감사하지 않은 파일/);
    await rm(join(root, ".vercel/output/static/extra.js"));
    await rm(join(root, ".vercel/output/static/index.html"));
    await assert.rejects(checkPrebuiltOutput(root), /빠진 파일/);
    await writeFile(join(root, ".vercel/output/static/index.html"), "<!doctype html><title>demo</title>");
    await mkdir(join(root, ".vercel/output/functions/api.func"), { recursive: true });
    await assert.rejects(checkPrebuiltOutput(root), /서버 함수/);
    await rm(join(root, ".vercel/output/functions"), { recursive: true });
    await writeFile(join(root, ".vercel/output/config.json"), JSON.stringify({ version: 3 }));
    await assert.rejects(checkPrebuiltOutput(root), /라우트/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
