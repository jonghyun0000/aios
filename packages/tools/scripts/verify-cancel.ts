import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createRunCommandTool } from "../src/builtin/shell.js";

const exec = promisify(execFile);
const marker = `aios-cancel-${randomUUID()}`;
const controller = new AbortController();
const tool = createRunCommandTool({ image: "aios-sandbox:latest" });
const args = tool.schema.parse({ command: `sleep 60 # ${marker}`, cwd: "." });
const result = tool.handler({ orgId: "verify", sessionId: "verify", projectRoot: "/Volumes/T7/bigdata/workspaces/my-first-project", signal: controller.signal }, args)
  .then(() => false, () => true);
const running = async () => {
  const { stdout } = await exec("docker", ["ps", "--no-trunc", "--format", "{{.Command}}"]);
  return stdout.includes(marker);
};
try {
  for (let n = 0; n < 30 && !(await running()); n++) await delay(100);
  assert.ok(await running(), "실제 sleep 컨테이너가 시작되어야 함");
  controller.abort();
  assert.equal(await result, true, "취소가 실패로 반환되어야 함");
  for (let n = 0; n < 30 && await running(); n++) await delay(100);
  assert.equal(await running(), false, "Docker CLI뿐 아니라 실행 컨테이너도 사라져야 함");
  console.log("PASS: 실제 실행 컨테이너를 확인한 뒤 취소·제거 검증");
} finally { controller.abort(); }
