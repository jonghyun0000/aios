import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 시작기로 띄운 API를 통해 모델→파일 편집→Docker 실행→대화 저장을 실제로 확인한다.
const base = process.env.AIOS_BASE_URL ?? "http://127.0.0.1:8791";
const get = async (path) => {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  return response.json();
};
const me = await get("/v1/me");
assert.equal(me.via, "local");
assert.ok(me.workspaceRoot?.startsWith("/Volumes/T7/"));
const categories = await get("/v1/bigdata/categories");
assert.ok(categories.categories.length > 0);
console.log("PASS: 키 없는 로그인 및 실제 공공통계 조회");

for (const value of [42, 56]) {
  const name = `aios-example-${value}.js`;
  const created = await fetch(base + "/v1/sessions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `사용 예제: 파일 만들고 ${value} 출력하기` }),
  });
  assert.ok(created.ok);
  const { id } = await created.json();
  const response = await fetch(`${base}/v1/sessions/${id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `작업 폴더에 ${name} 파일을 만들고 내용은 console.log(${value}); 한 줄로 저장해. 이어서 run_command 도구로 node ${name} 명령을 실행하고 실제 출력값을 한국어로 짧게 알려줘. 반드시 도구로 파일 저장과 실행을 수행해.`,
      tools: { enabled: true }, context: { useMemory: false, useRag: false },
    }),
    signal: AbortSignal.timeout(600_000),
  });
  assert.equal(response.status, 200);
  let buffer = "";
  const decoder = new TextDecoder();
  const events = [];
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!frame.startsWith("data: ")) continue;
      const event = JSON.parse(frame.slice(6));
      events.push(event);
      if (["routed", "tool_start", "tool_result", "error"].includes(event.type)) console.log(name, JSON.stringify(event));
    }
  }
  assert.ok(!events.some(e => e.type === "error"), "스트림 오류");
  const run = events.find(e => e.type === "tool_start" && e.call.name === "run_command");
  assert.ok(run, "명령 실행 도구가 실제 호출되어야 함");
  assert.ok(events.some(e => e.type === "tool_result" && e.id === run.call.id && e.ok && e.summary.trim() === String(value)), "실제 실행 결과 불일치");
  assert.match(await readFile(join(me.workspaceRoot, name), "utf8"), new RegExp(`console\\.log\\(${value}\\)`));
  const history = await get(`/v1/sessions/${id}/messages`);
  assert.ok(history.messages.some(m => m.role === "assistant" && m.content.text.includes(String(value))), "대화가 저장되어야 함");
  console.log(`PASS: ${name} — 실제 생성·샌드박스 출력·대화 저장 (${id})`);
}
