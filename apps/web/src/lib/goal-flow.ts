/**
 * 실행 기록을 "목표 → 진행 단계 → 결과"로 묶는다(docs/42). 모델의 말이 아니라 서버 실행 기록만 쓴다.
 * 단계는 모델이 미리 세운 계획이 아니라 실제로 일어난 작업 순서다.
 */
export interface FlowAction {
  id: string; tool_name: string; status: string; purpose: string;
  arguments: { path?: string; command?: string };
  exit_code: number | null; after_hash: string | null;
}
export interface FlowRun { id: string; status: string; summary: string; created_at: string; goal?: string | null; resumed_from?: string | null; verification_command?: string | null; actions: FlowAction[] }

export const RESUMABLE = new Set(["cancelled", "interrupted", "failed", "unverified"]);
export const RESUME_LIMIT = 3;
const STEP: Record<string, string> = { running: "실행 중", pending: "승인 대기", approved: "승인됨", rejected: "거절됨", expired: "승인 만료", passed: "완료", unchanged: "변경 없음(이미 같은 내용)", failed: "실패", cancelled: "중단됨", interrupted: "연결 중단", restored: "복구됨", restoring: "복구 중", restore_conflict: "복구 충돌" };

export interface RunFlow {
  goal: string;
  goalRecorded: boolean;
  resumedFrom: string | null;
  steps: Array<{ id: string; text: string; state: string; tone: "ok" | "warn" | "err" | "wait" }>;
  files: Array<{ path: string; hash: string; state: "saved" | "unchanged" | "restored" }>;
  verification: { command: string; exitCode: number | null; passed: boolean; ran: boolean } | null;
  verdict: { tone: "ok" | "warn" | "err" | "wait"; text: string };
  resume: { allowed: boolean; reason: string };
}

const tone = (status: string): RunFlow["steps"][number]["tone"] =>
  status === "passed" || status === "unchanged" ? "ok" : status === "pending" || status === "running" || status === "approved" ? "wait" : status === "failed" || status === "rejected" || status === "restore_conflict" ? "err" : "warn";

/** runs 는 같은 대화의 기록(최근 20개). 이어서 하기 체인 길이·중복 여부를 여기서 계산한다. */
export function presentRun(run: FlowRun, runs: FlowRun[]): RunFlow {
  const goalRecorded = typeof run.goal === "string" && run.goal.trim().length > 0;
  const steps = run.actions.map((a, i) => {
    const what = a.purpose === "verification" ? `검증 명령 실행: ${a.arguments.command ?? ""}` : a.tool_name === "write_file" ? `파일 쓰기: ${a.arguments.path ?? ""}`
      : a.tool_name === "run_command" ? `명령 실행: ${a.arguments.command ?? ""}` : `${a.tool_name}${a.arguments.path ? `: ${a.arguments.path}` : ""}`;
    const exit = a.exit_code !== null ? ` · 종료 코드 ${a.exit_code}` : "";
    return { id: a.id, text: `${i + 1}. ${what}`, state: `${STEP[a.status] ?? a.status}${exit}`, tone: tone(a.status) };
  });
  const files: RunFlow["files"] = run.actions.flatMap((a) => a.tool_name === "write_file" && a.arguments.path && a.after_hash && ["passed", "unchanged", "restored"].includes(a.status)
    ? [{ path: a.arguments.path, hash: a.after_hash.slice(0, 12), state: a.status === "passed" ? "saved" as const : a.status === "unchanged" ? "unchanged" as const : "restored" as const }] : []);
  const check = [...run.actions].reverse().find((a) => a.purpose === "verification");
  const verification = run.verification_command
    ? { command: run.verification_command, exitCode: check?.exit_code ?? null, ran: !!check && check.exit_code !== null, passed: !!check && check.status === "passed" && check.exit_code === 0 }
    : null;
  const verdict: RunFlow["verdict"] =
    run.status === "verified" ? { tone: "ok", text: "검증 통과 — 지정한 검증 명령이 종료 코드 0으로 끝났습니다. 전체 요구사항의 정확성까지 보증하지는 않습니다." }
    : run.status === "running" ? { tone: "wait", text: "진행 중 — 승인이나 실행 결과를 기다립니다." }
    : run.status === "unverified" ? { tone: "warn", text: verification ? "미검증 — 검증 명령이 통과하지 않았습니다." : "미검증 — 검증 명령을 지정하지 않아 동작은 확인하지 않았습니다." }
    : run.status === "restored" ? { tone: "warn", text: "복구됨 — 변경을 되돌렸습니다. 이전 검증은 복구 전 상태의 결과입니다." }
    : { tone: "err", text: `완료되지 않음 — ${run.summary || "실행 기록을 확인하세요."}` };
  // 체인 길이(몇 번째 이어서 하기인지)와 이미 이어서 한 실행인지. 서버가 같은 조건을 다시 검사한다.
  let depth = 0; let cursor = run.resumed_from ?? null;
  while (cursor && depth < 10) { depth++; cursor = runs.find((r) => r.id === cursor)?.resumed_from ?? null; }
  const resumedAlready = runs.some((r) => r.resumed_from === run.id);
  const resume = !RESUMABLE.has(run.status) ? { allowed: false, reason: "" }
    : resumedAlready ? { allowed: false, reason: "이미 이어서 실행했습니다. 가장 최근 실행에서 이어서 하세요." }
    : depth >= RESUME_LIMIT ? { allowed: false, reason: `같은 목표는 ${RESUME_LIMIT}회까지 이어서 할 수 있습니다. 목표를 나누거나 새로 요청하세요.` }
    : { allowed: true, reason: `이어서 하기 ${depth + 1}/${RESUME_LIMIT}` };
  return { goal: goalRecorded ? run.goal!.trim() : "목표 기록 없음(이전 버전의 실행)", goalRecorded, resumedFrom: run.resumed_from ?? null, steps, files, verification, verdict, resume };
}

export const RESUME_PROMPT = "이전 실행을 이어서 남은 작업을 마무리해줘. 이미 끝난 파일은 다시 쓰지 말고, 필요한 경우에만 고쳐줘.";
