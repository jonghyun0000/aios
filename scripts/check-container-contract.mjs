#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 현재 지원하는 단순 버전 정책만 해석한다. 알 수 없는 범위를 추측해 CI를 초록으로 만들지 않는다.
export function checkContainerContract(manifest, dockerfile, npmrc) {
  const minimum = /^>=(\d+)\.0\.0$/.exec(manifest.engines?.node ?? "");
  assert(minimum, "Node engines 정책을 검사기에 명시해야 합니다.");
  const manager = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
  assert(manager, "pnpm은 정확한 버전으로 고정해야 합니다.");
  const lines = dockerfile.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  assert.equal(lines.filter(line => /^FROM node:/.test(line)).length, 1, "Node 베이스는 하나여야 합니다.");
  assert(lines.includes(`FROM node:${minimum[1]}-slim AS base`), "이미지 Node와 engines의 지원 major가 다릅니다.");
  assert(lines.includes(`RUN corepack enable && corepack prepare pnpm@${manager[1]} --activate`), "이미지 pnpm과 packageManager가 다릅니다.");
  assert.equal(manifest.devDependencies?.pnpm, manager[1], "직접 pnpm 의존성도 동일해야 합니다.");
  assert(/^engine-strict=true\s*$/m.test(npmrc), "engine-strict를 끄지 마세요.");
  assert(lines.includes("RUN pnpm install --frozen-lockfile"), "고정 lockfile 설치가 필요합니다.");
  for (const target of ["api", "worker"]) assert(lines.includes(`FROM runtime AS ${target}`), `${target}은 공통 runtime을 사용해야 합니다.`);
  return { nodeMajor: Number(minimum[1]), pnpm: manager[1] };
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  const root = resolve(dirname(here), "..");
  const result = checkContainerContract(JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    await readFile(join(root, "infra/Dockerfile"), "utf8"), await readFile(join(root, ".npmrc"), "utf8"));
  console.log(JSON.stringify({ status: "PASS", ...result, scope: "정적 버전 계약; 실제 이미지 빌드·기동은 별도" }));
}
