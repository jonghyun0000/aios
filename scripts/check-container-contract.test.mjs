import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkContainerContract } from "./check-container-contract.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const dockerfile = await readFile(new URL("infra/Dockerfile", root), "utf8");
const npmrc = await readFile(new URL(".npmrc", root), "utf8");

test("실제 저장소의 이미지·Node·pnpm·lockfile 계약", () => {
  assert.deepEqual(checkContainerContract(manifest, dockerfile, npmrc), { nodeMajor: 22, pnpm: "9.12.0" });
});
test("결함 주입: 이전 Node20 이미지와 다른 pnpm을 각각 거부", () => {
  assert.throws(() => checkContainerContract(manifest, dockerfile.replace("node:22-slim", "node:20-slim"), npmrc), /이미지 Node/);
  assert.throws(() => checkContainerContract(manifest, dockerfile.replace("pnpm@9.12.0", "pnpm@9.15.9"), npmrc), /이미지 pnpm/);
});
test("결함 주입: engine-strict·고정 설치·공통 runtime 제거 거부", () => {
  assert.throws(() => checkContainerContract(manifest, dockerfile, npmrc.replace("engine-strict=true", "engine-strict=false")), /engine-strict/);
  assert.throws(() => checkContainerContract(manifest, dockerfile.replace("--frozen-lockfile", "--no-frozen-lockfile"), npmrc), /lockfile/);
  assert.throws(() => checkContainerContract(manifest, dockerfile.replace("FROM runtime AS worker", "FROM base AS worker"), npmrc), /공통 runtime/);
});
test("결함 주입: 해석하지 않는 범위와 추가 Node 베이스 거부", () => {
  assert.throws(() => checkContainerContract({ ...manifest, engines: { node: "*" } }, dockerfile, npmrc), /정책/);
  assert.throws(() => checkContainerContract(manifest, dockerfile + "\nFROM node:20-slim AS extra", npmrc), /하나/);
  assert.throws(() => checkContainerContract({ ...manifest, devDependencies: { ...manifest.devDependencies, pnpm: "9.15.9" } }, dockerfile, npmrc), /직접 pnpm/);
});
