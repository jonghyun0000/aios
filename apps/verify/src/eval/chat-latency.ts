import { mkdir, writeFile } from "node:fs/promises";
import { parseSse } from "@aios/ai";

// 실제 웹 채팅과 같은 API 경로. 최소 3회 반복하며 빈 응답/오답/스트림 오류는 실패다.
// 기존 모드는 옵션을 생략해 이전 빌드의 기본 동작도 같은 러너로 측정한다.
const base = process.env.AIOS_BASE_URL ?? "http://127.0.0.1:8791";
const mode = process.env.CHAT_MODE ?? "legacy";
const scenario = process.env.CHAT_SCENARIO ?? "short";
if (!["short", "guide", "context", "arithmetic"].includes(scenario)) throw new Error("invalid CHAT_SCENARIO");
const repeats = Math.max(3, Number(process.env.REPEATS) || 3);
if (!["legacy", "fast", "thorough"].includes(mode)) throw new Error("invalid CHAT_MODE");
const headers = { "content-type": "application/json", ...(process.env.AIOS_API_KEY ? { authorization: `Bearer ${process.env.AIOS_API_KEY}` } : {}) };

async function ask(id: string, content: string) {
  const started = performance.now();
  const response = await fetch(`${base}/v1/sessions/${id}/messages`, {
    method: "POST", headers, signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({ content, tools: { enabled: false }, ...(mode === "legacy" ? {} : {
      routing: { taskClass: "chat", reasoning: mode === "fast" ? "off" : "auto" },
      context: { useMemory: true, useLongTermMemory: mode !== "fast", useRag: false },
    }) }),
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  let text = "";
  let firstTextMs: number | null = null;
  let routedMs: number | null = null;
  let done = false;
  for await (const frame of parseSse(response.body)) {
    if (!frame.data) continue;
    const event = JSON.parse(frame.data) as { type: string; text?: string; message?: string };
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "routed") routedMs ??= Math.round(performance.now() - started);
    if (event.type === "done") done = true;
    if (event.type === "text_delta" && event.text) {
      firstTextMs ??= Math.round(performance.now() - started);
      text += event.text;
    }
  }
  if (!done || !text.trim()) throw new Error("incomplete or empty answer");
  return { firstTextMs, routedMs, totalMs: Math.round(performance.now() - started), text };
}

const results: { repeat: number; firstTextMs: number | null; routedMs: number | null; totalMs: number; text: string; pass: boolean }[] = [];
for (let i = 0; i < repeats; i++) {
  const response = await fetch(`${base}/v1/sessions`, { method: "POST", headers, body: JSON.stringify({ title: `2차 검증 · ${scenario} · ${mode} ${i + 1}` }) });
  if (!response.ok) throw new Error(`create HTTP ${response.status}`);
  const { id } = await response.json() as { id: string };
  if (scenario === "context") await ask(id, `이 대화에서 내 프로젝트 이름은 자작나무${i + 1}입니다. 기억하고 짧게 확인만 해주세요.`);
  const prompt = scenario === "context" ? "방금 말한 내 프로젝트 이름만 답해주세요."
    : scenario === "guide" ? "오늘 할 일을 효율적으로 정리하는 방법을 한국어로 세 문장으로 설명해 주세요."
    : scenario === "arithmetic" ? "What is 17 * 23? Reply with only the number."
    : "17 + 25는? 다른 설명 없이 정답 숫자만 답하세요.";
  const answer = await ask(id, prompt);
  const pass = scenario === "context" ? answer.text.includes(`자작나무${i + 1}`)
    : scenario === "guide" ? /[가-힣]/.test(answer.text) && answer.text.length > 30 && !/[一-鿿぀-ヿ]/.test(answer.text)
    : answer.text.trim() === (scenario === "arithmetic" ? "391" : "42");
  const result = { repeat: i + 1, ...answer, pass };
  results.push(result);
  console.log(JSON.stringify(result));
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const report = { at: new Date().toISOString(), mode, scenario, repeats, results, medianFirstTextMs: median(results.map((r) => r.firstTextMs!)), medianTotalMs: median(results.map((r) => r.totalMs)) };
const dir = "/Volumes/T7/bigdata/eval-baselines";
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/chat-v2-${scenario}-${mode}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ mode, scenario, passed: results.filter((r) => r.pass).length, repeats, firstTextMs: report.medianFirstTextMs, totalMs: report.medianTotalMs }));
if (results.some((r) => !r.pass)) process.exitCode = 1;
