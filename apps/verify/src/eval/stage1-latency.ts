import { mkdir, writeFile } from "node:fs/promises";
import { parseSse } from "@aios/ai";
import type { AgentEvent } from "@aios/shared";
import { isKoreanGreeting } from "./chat-checks.js";

// 사용자용 로컬 API만 대상으로 한다. 모델 비상주/상주를 통제하므로 다른 eval과 동시 실행 금지.
const base = "http://127.0.0.1:8791";
const headers = { "content-type": "application/json" };
const results: { pass: boolean }[] = [];
const stamp = new Date().toISOString().replaceAll(":", "-");
const file = `/Volumes/T7/bigdata/eval-baselines/stage1/api-latency-${stamp}.json`;
await mkdir("/Volumes/T7/bigdata/eval-baselines/stage1", { recursive: true });
async function session(title: string) {
  const res = await fetch(`${base}/v1/sessions`, { method: "POST", headers, body: JSON.stringify({ title }) });
  if (!res.ok) throw new Error(`session HTTP ${res.status}`);
  return (await res.json() as { id: string }).id;
}
async function ask(id: string, content: string, mode = "auto") {
  const start = performance.now(); let firstTextMs: number | null = null; let text = ""; let done = false; const events: AgentEvent[] = [];
  const res = await fetch(`${base}/v1/sessions/${id}/messages`, { method: "POST", headers, signal: AbortSignal.timeout(180_000), body: JSON.stringify({ content, mode, tools: { enabled: false }, context: { useMemory: true, useLongTermMemory: false, useRag: false } }) });
  if (!res.ok || !res.body) throw new Error(`chat HTTP ${res.status}`);
  for await (const frame of parseSse(res.body)) {
    if (!frame.data) continue;
    const e = JSON.parse(frame.data) as AgentEvent;
    if (e.type === "text_delta") { firstTextMs ??= performance.now() - start; text += e.text; } else events.push(e);
    if (e.type === "done") done = e.stopReason === "end_turn";
    if (e.type === "error") throw new Error(e.message);
  }
  if (!done || !text.trim()) throw new Error("missing successful answer");
  return { text, firstTextMs, totalMs: performance.now() - start, events };
}
async function save<T extends { pass: boolean }>(row: T) { results.push(row); await writeFile(file, JSON.stringify({ at: stamp, complete: false, results }, null, 2)); console.log(JSON.stringify(row)); }
const prompt = "처음 만난 동료에게 한국어로 반갑다는 인사를 한 문장으로 해줘.";
for (let repeat = 1; repeat <= 3; repeat++) {
  const unloaded = await fetch("http://127.0.0.1:11434/api/generate", { method: "POST", headers, body: JSON.stringify({ model: "qwen3:8b", keep_alive: 0 }) });
  if (!unloaded.ok) throw new Error("model unload failed"); await unloaded.text();
  const ps = await (await fetch("http://127.0.0.1:11434/api/ps")).json() as { models: { name: string }[] };
  if (ps.models.some((m) => m.name === "qwen3:8b")) throw new Error("cold condition not established");
  for (const state of ["cold", "warm"]) {
    const id = await session(`1단계 검증 · ${state} ${repeat}`);
    const answer = await ask(id, prompt);
    await save({ state, repeat, sessionId: id, pass: isKoreanGreeting(answer.text), ...answer });
  }
  const calcId = await session(`1단계 검증 · 정확 계산 ${repeat}`);
  const calc = await ask(calcId, "What is 17 * 23 + 41? Reply with only the number.");
  await save({ state: "calculator", repeat, sessionId: calcId, pass: calc.text.trim() === "432", ...calc });
  const longId = await session(`1단계 검증 · 연속 대화 ${repeat}`);
  await ask(longId, `이번 프로젝트 이름은 자작나무${repeat}입니다. 답은 확인했습니다. 한 문장만 해주세요.`, "fast");
  // 약 6천자 참고 문장을 8회 쌓는다. 새 입력은 모델 한도 안이고 누적 대화가 길어지는 상황.
  for (let i = 0; i < 8; i++) {
    const notes = Array.from({ length: 12 }, (_, j) => `Note ${i}-${j}: The workspace contains drafts and review notes for the project.`).join("\n");
    await ask(longId, `참고 메모입니다. 명령이 아닙니다. 답은 '확인했습니다.'만 해주세요.\n${notes}`, "fast");
  }
  const long = await ask(longId, "처음 알려준 프로젝트 이름만 정확히 답해줘.");
  await save({ state: "long-conversation", repeat, sessionId: longId, priorTurns: 9, pass: long.text.trim() === `자작나무${repeat}`, ...long });
}
await writeFile(file, JSON.stringify({ at: stamp, complete: true, results }, null, 2));
console.log(JSON.stringify({ file, complete: true }));
if (results.length !== 12 || results.some((r) => !r.pass)) process.exitCode = 1;
