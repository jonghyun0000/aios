import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./dev-up.sh", import.meta.url));
const temporaryRoot = existsSync("/Volumes/T7")
  ? "/Volumes/T7/bigdata/tests"
  : await realpath(tmpdir());

async function fixture(t, { withPnpm = false } = {}) {
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, "dev-up-preflight-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(bin);

  // dev-up.sh의 ROOT 계산만 통과시킨다. 그 뒤 외부 명령이 호출되면 fixture가 불완전한
  // 것이 아니라 사전 검사가 늦어진 회귀다. 실제 설정·Docker·키에는 닿지 않는다.
  const dirnameStub = join(bin, "dirname");
  await writeFile(dirnameStub, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(join(project, "scripts"))}\n`);
  await chmod(dirnameStub, 0o700);
  if (withPnpm) {
    const pnpmStub = join(bin, "pnpm");
    await writeFile(pnpmStub, "#!/bin/sh\nexit 0\n");
    await chmod(pnpmStub, 0o700);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return bin;
}

async function failedRun(path, args = []) {
  let failure;
  try {
    await exec("/bin/bash", [script, ...args], { env: { PATH: path }, timeout: 5_000 });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "dev-up fixture는 의도한 사전조건에서 실패해야 한다");
  assert.equal(failure.code, 1);
  return failure;
}

test("pnpm이 PATH에 없으면 사용자 상태 확인 전에 직접 원인과 복구 명령을 출력", async t => {
  const bin = await fixture(t);
  const failure = await failedRun(bin);
  assert.match(failure.stderr, /pnpm을 PATH에서 찾을 수 없다/);
  assert.match(failure.stderr, /API 서버를 시작하지 않았다/);
  assert.match(failure.stderr, /AGENTS\.md/);
  assert.match(failure.stderr, /export PATH="\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/local\/lib\/node_modules\/corepack\/shims:\$PATH"/);
  assert.match(failure.stderr, /command -v pnpm/);
  assert.doesNotMatch(failure.stderr, /설정이 없다|docker|ollama|API 서버가 뜨지 않았다/);
});

test("export-only는 서비스를 시작하지 않으므로 pnpm을 요구하지 않음", async t => {
  const bin = await fixture(t);
  const failure = await failedRun(bin, ["--export-only"]);
  assert.match(failure.stderr, /설정이 없다/);
  assert.doesNotMatch(failure.stderr, /pnpm을 PATH에서 찾을 수 없다/);
});

test("pnpm이 PATH에 있으면 기존 기동 사전조건으로 진행", async t => {
  const bin = await fixture(t, { withPnpm: true });
  const failure = await failedRun(bin);
  assert.match(failure.stderr, /설정이 없다/);
  assert.doesNotMatch(failure.stderr, /pnpm을 PATH에서 찾을 수 없다/);
});
