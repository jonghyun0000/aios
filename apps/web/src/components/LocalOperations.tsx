import { api } from "../lib/api.js";
import { AsyncBoundary, useAsync } from "./Async.js";
import "./local-operations.css";

interface Backup { id: string; createdAt: string; bytes: number }
interface RestoreCheck { backupId: string; checkedAt: string; status: "passed" | "failed"; restoredDatabase?: string; files?: number }
interface Operations {
  version: 1;
  observedAt: string;
  backupRoot: string;
  history: { state: "empty" | "recorded" | "invalid" | "unavailable"; message?: string; lastBackup?: Backup; lastRestoreCheck?: RestoreCheck };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const isId = (value: unknown): value is string => typeof value === "string" && /^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(value);
function parseOperations(value: unknown): Operations {
  // 낡은 서버/프록시의 잘못된 응답을 성공 기록으로 렌더링하지 않는다.
  if (!isObject(value) || value.version !== 1 || value.mode !== "local-read-only" || !isDate(value.observedAt) || value.backupRoot !== "/Volumes/T7/bigdata/backups/local" || !isObject(value.history)) throw new Error("운영 기록 응답 형식이 올바르지 않습니다.");
  const h = value.history;
  if (!["empty", "recorded", "invalid", "unavailable"].includes(String(h.state))) throw new Error("운영 기록 응답 형식이 올바르지 않습니다.");
  if (h.message !== undefined && (typeof h.message !== "string" || h.message.length > 500)) throw new Error("운영 기록 응답 형식이 올바르지 않습니다.");
  if (h.lastBackup !== undefined) {
    const b = h.lastBackup;
    if (!isObject(b) || !isId(b.id) || !isDate(b.createdAt) || typeof b.bytes !== "number" || !Number.isSafeInteger(b.bytes) || b.bytes <= 0) throw new Error("백업 기록의 필수 정보가 없습니다.");
  }
  if (h.lastRestoreCheck !== undefined) {
    const r = h.lastRestoreCheck;
    if (!isObject(r) || !isId(r.backupId) || !isDate(r.checkedAt) || !["passed", "failed"].includes(String(r.status)) ||
      (r.files !== undefined && (typeof r.files !== "number" || !Number.isInteger(r.files) || r.files < 0 || r.files > 1_000_000)) ||
      (r.restoredDatabase !== undefined && (typeof r.restoredDatabase !== "string" || !/^aios_restore_[a-z0-9_]{1,50}$/.test(r.restoredDatabase))) ||
      (r.status === "passed" && (r.files === undefined || r.restoredDatabase === undefined))) throw new Error("복원 검사 기록의 필수 검증 정보가 없습니다.");
  }
  if ((h.state !== "recorded" && (h.lastBackup !== undefined || h.lastRestoreCheck !== undefined)) || (h.state === "recorded" && !h.lastBackup && !h.lastRestoreCheck)) throw new Error("운영 기록의 상태가 일치하지 않습니다.");
  return value as unknown as Operations;
}

const dateText = (value: string) => new Date(value).toLocaleString("ko-KR");
const byteText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${bytes.toLocaleString("ko-KR")} 바이트`;

export function LocalOperations() {
  const state = useAsync(async () => parseOperations(await api<unknown>("/v1/local/operations", { signal: AbortSignal.timeout(10_000) })), []);
  const history = state.data?.history;
  return (
    <section className="local-operations" aria-labelledby="local-operations-title">
      <div className="operations-heading">
        <div><h2 id="local-operations-title">내 컴퓨터 운영</h2><p className="small muted">실행과 백업은 프로젝트 폴더의 명령 파일에서 관리합니다.</p></div>
        <button type="button" className="secondary" onClick={state.reload} disabled={state.loading}>운영 기록 새로고침</button>
      </div>
      <div className="card operations-guide">
        <h3>더블클릭으로 관리하기</h3>
        <dl>
          <div><dt>시작</dt><dd><code>AIOS 시작.command</code><span> T7를 연결하고 실행하세요. 이미 켜져 있으면 중복으로 띄우지 않습니다.</span></dd></div>
          <div><dt>종료</dt><dd><code>AIOS 종료.command</code><span> AIOS 앱 프로세스만 종료합니다. 공유 DB·모델 서비스와 저장 데이터는 남습니다.</span></dd></div>
          <div><dt>상태 확인</dt><dd><code>AIOS 상태 확인.command</code><span> 기동이 안 되거나 연결이 끊겼을 때 현재 상태와 문제를 확인하세요.</span></dd></div>
          <div><dt>백업</dt><dd><code>AIOS 백업.command</code><span> 먼저 AIOS를 종료하세요. DB·작업 파일·변경 복구 지점을 함께 보관합니다.</span></dd></div>
          <div><dt>복원 검사</dt><dd><code>AIOS 복원 검사.command</code><span> 백업을 새 DB·새 폴더에 격리 복원해 검사합니다. 기존 DB와 작업 폴더는 덮어쓰지 않습니다.</span></dd></div>
        </dl>
        <p className="small muted">백업 위치: <code>/Volumes/T7/bigdata/backups/local</code><br />이 화면은 읽기 전용입니다. 버튼으로 서버 종료·백업·복원을 실행하지 않습니다.</p>
      </div>
      <div className="operations-records" aria-live="polite" aria-busy={state.loading}>
        <AsyncBoundary loading={state.loading} error={state.error}>
          {history && (history.state === "invalid" || history.state === "unavailable") ? <div className="alert" role="alert">{history.message ?? "운영 기록을 확인할 수 없습니다."} 성공 여부를 판단할 수 없습니다.</div> : history && <>
            <article className="card" aria-labelledby="last-backup-title">
              <h3 id="last-backup-title">최근 백업</h3>
              {history.lastBackup ? <><p className="operations-record-state">백업 생성 기록</p><dl className="operations-facts"><div><dt>생성 시각</dt><dd>{dateText(history.lastBackup.createdAt)}</dd></div><div><dt>크기</dt><dd>{byteText(history.lastBackup.bytes)}</dd></div><div><dt>백업 ID</dt><dd><code>{history.lastBackup.id}</code></dd></div></dl></> : <p className="muted">아직 백업을 하지 않았습니다.</p>}
            </article>
            <article className="card" aria-labelledby="last-restore-title">
              <h3 id="last-restore-title">최근 복원 검사</h3>
              {history.lastRestoreCheck ? <><p className={`operations-record-state ${history.lastRestoreCheck.status === "failed" ? "operations-failed" : ""}`}>{history.lastRestoreCheck.status === "passed" ? "검사 당시 통과" : "검사 실패 — 복원 가능 여부 확인 필요"}</p><dl className="operations-facts"><div><dt>검사 시각</dt><dd>{dateText(history.lastRestoreCheck.checkedAt)}</dd></div><div><dt>대상 백업</dt><dd><code>{history.lastRestoreCheck.backupId}</code></dd></div>{history.lastRestoreCheck.restoredDatabase !== undefined && <div><dt>격리 DB</dt><dd><code>{history.lastRestoreCheck.restoredDatabase}</code></dd></div>}{history.lastRestoreCheck.files !== undefined && <div><dt>검사 파일</dt><dd>{history.lastRestoreCheck.files.toLocaleString("ko-KR")}개</dd></div>}</dl></> : <p className="muted">아직 복원 검사를 하지 않았습니다.</p>}
            </article>
          </>}
          {state.data && <p className="small muted operations-caveat">기록 조회: {dateText(state.data.observedAt)}. 표시된 결과는 각 기록 시점의 결과이며, 지금 백업이 온전하거나 앱이 정상이라는 보장은 아닙니다. 사용 전 복원 검사로 다시 확인하세요.</p>}
        </AsyncBoundary>
      </div>
    </section>
  );
}
