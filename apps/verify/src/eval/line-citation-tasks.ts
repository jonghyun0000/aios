/**
 * 행 번호 인용 평가 — 보고용 홀드아웃 과제(NEXT_STEPS 5-2, docs/40).
 *
 * 규칙: 이 파일은 모델을 한 번도 돌리기 전에 커밋하고 SHA256을 기록한다. 결과를 본 뒤 과제·정답·채점기를
 * 고치지 않는다. 고쳐야 하면 새 파일로 새 과제를 만들고 이전 결과를 보존한다.
 * 합성 자료만 쓴다. 기존 맥락 8과제·재현용 `제품계획.md`와 겹치지 않는다.
 */
export interface LineFile { id: string; name: string; content: string }
export interface LineCitationTask {
  id: string;
  kind: "line" | "value";
  files: LineFile[];
  prompt: string;
  /** 답변에 그대로 들어 있어야 하는 값(공백 무시 비교) */
  value: string;
  /** kind=line 일 때 정답 행 번호(1부터) */
  line?: number;
}

const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** filler(i)로 total줄을 만들고 facts의 행(1부터)을 덮어쓴다. */
function build(total: number, filler: (i: number) => string, facts: Record<number, string>, eol = "\n"): string {
  return Array.from({ length: total }, (_, i) => facts[i + 1] ?? filler(i + 1)).join(eol);
}
const meeting = (i: number) => `- 참석자 발언 ${i}: 일정 공유와 진행 상황 점검`;
const config = (i: number) => `option_${i} = default`;
const csv = (i: number) => `${1000 + i},서울,${(i * 37) % 100},정상`;
const log = (i: number) => `2026-08-${String((i % 28) + 1).padStart(2, "0")} 12:00:${String(i % 60).padStart(2, "0")} INFO worker heartbeat ok`;
const prose = (i: number) => (i % 4 === 0 ? "" : `본문 ${i}: 이 단락은 배경 설명이며 특별한 수치는 없다.`);
const english = (i: number) => `Note ${i}: routine status update with no figures.`;

type Spec = Omit<LineCitationTask, "files" | "kind"> & { name: string; content: string; extra?: LineFile[] };
const lineTask = (n: number, spec: Spec): LineCitationTask => ({
  id: spec.id, kind: "line", prompt: spec.prompt, value: spec.value, line: spec.line,
  files: [{ id: uuid(n), name: spec.name, content: spec.content }, ...(spec.extra ?? [])],
});
const ASK = "값과 그 값이 적힌 행 번호를 함께 알려줘.";

export const LINE_CITATION_TASKS: LineCitationTask[] = [
  lineTask(1, { id: "meeting-budget-47", name: "회의록.md", content: build(80, meeting, { 46: "- 검토 의견: 예산 상한 초안 3,800만 원(폐기)", 47: "- 결정 사항: 예산 상한 4,200만 원" }), prompt: `회의록에서 최종 결정된 예산 상한의 ${ASK}`, value: "4,200만", line: 47 }),
  lineTask(2, { id: "meeting-owner-12", name: "킥오프.md", content: build(40, meeting, { 12: "- 결정 사항: 책임자는 오세린" }), prompt: `킥오프 문서에서 정해진 책임자 이름의 ${ASK}`, value: "오세린", line: 12 }),
  lineTask(3, { id: "config-timeout-133", name: "server.conf", content: build(180, config, { 133: "request_timeout_ms = 7250" }), prompt: `server.conf 에서 request_timeout_ms ${ASK}`, value: "7250", line: 133 }),
  lineTask(4, { id: "config-port-6", name: "agent.conf", content: build(60, config, { 6: "listen_port = 48213" }), prompt: `agent.conf 의 listen_port ${ASK}`, value: "48213", line: 6 }),
  lineTask(5, { id: "csv-busan-212", name: "지점현황.csv", content: build(260, csv, { 1: "코드,지역,점수,상태", 212: "1212,부산,88,점검필요" }), prompt: `지점현황.csv 에서 부산 지점의 상태 ${ASK}`, value: "점검필요", line: 212 }),
  lineTask(6, { id: "log-error-301", name: "worker.log", content: build(340, log, { 300: "2026-08-19 03:14:07 WARN disk usage 81%", 301: "2026-08-19 03:14:09 ERROR checksum mismatch at block 5521" }), prompt: `worker.log 에서 ERROR 가 난 블록 번호의 ${ASK}`, value: "5521", line: 301 }),
  lineTask(7, { id: "prose-deadline-58", name: "제안서.md", content: build(90, prose, { 58: "제출 마감: 2026년 12월 18일 오후 6시" }), prompt: `제안서에서 제출 마감 일시의 ${ASK}`, value: "12월 18일", line: 58 }),
  lineTask(8, { id: "prose-blank-lines-95", name: "정책.md", content: build(120, prose, { 95: "보존 기한: 개인 기록은 180일 후 파기한다." }), prompt: `정책 문서에서 개인 기록의 보존 기한 ${ASK}`, value: "180일", line: 95 }),
  lineTask(9, { id: "crlf-contract-73", name: "계약.txt", content: build(100, (i) => `조항 ${i}. 일반 조건을 따른다.`, { 73: "위약금 비율: 계약 금액의 12퍼센트" }, "\r\n"), prompt: `계약서의 위약금 비율 ${ASK}`, value: "12퍼센트", line: 73 }),
  lineTask(10, { id: "english-sla-164", name: "sla.md", content: build(200, english, { 164: "Uptime commitment: 99.95 percent per calendar month." }), prompt: `In sla.md, what is the uptime commitment? Give the value and the line number where it appears.`, value: "99.95", line: 164 }),
  lineTask(11, { id: "english-contact-9", name: "vendor.txt", content: build(50, english, { 9: "Escalation contact: Priya Raman" }), prompt: `In vendor.txt, who is the escalation contact? Give the name and its line number.`, value: "Priya Raman", line: 9 }),
  lineTask(12, { id: "near-dup-version-221", name: "릴리스노트.md", content: build(240, (i) => `변경 ${i}: 문서 표현 정리`, { 219: "배포 버전(예정): 3.8.0", 220: "배포 버전(보류): 3.8.1", 221: "배포 버전(확정): 3.9.0" }), prompt: `릴리스노트에서 확정된 배포 버전의 ${ASK}`, value: "3.9.0", line: 221 }),
  lineTask(13, { id: "near-dup-price-31", name: "견적.md", content: build(70, (i) => `항목 ${i}: 부가 조건 없음`, { 30: "단가(작년): 18,400원", 31: "단가(올해): 19,900원", 32: "단가(내년 제안): 21,000원" }), prompt: `견적 문서에서 올해 단가의 ${ASK}`, value: "19,900", line: 31 }),
  lineTask(14, { id: "two-files-second-88", name: "개요.md", content: build(40, prose, {}), extra: [{ id: uuid(114), name: "세부사항.md", content: build(110, (i) => `세부 ${i}: 참고 항목`, { 88: "검수 담당 부서: 품질보증2팀" }) }], prompt: `세부사항 문서에서 검수 담당 부서의 ${ASK}`, value: "품질보증2팀", line: 88 }),
  lineTask(15, { id: "code-constant-142", name: "limits.ts", content: build(170, (i) => `export const PLACEHOLDER_${i} = ${i};`, { 142: "export const MAX_UPLOAD_MB = 37;" }), prompt: `limits.ts 에서 MAX_UPLOAD_MB ${ASK}`, value: "37", line: 142 }),
  lineTask(16, { id: "yaml-replicas-27", name: "deploy.yaml", content: build(45, (i) => `  label_${i}: common`, { 26: "replicas:", 27: "  count: 5" }), prompt: `deploy.yaml 에서 replicas 의 count ${ASK}`, value: "5", line: 27 }),
  lineTask(17, { id: "csv-header-offset-3", name: "재고.csv", content: build(30, csv, { 1: "코드,지역,점수,상태", 3: "1003,대전,12,재고부족" }), prompt: `재고.csv 에서 대전의 상태 ${ASK}`, value: "재고부족", line: 3 }),
  lineTask(18, { id: "long-doc-late-377", name: "운영매뉴얼.md", content: build(400, prose, { 377: "백업 보관 위치: 서고 B-14 금고" }), prompt: `운영매뉴얼에서 백업 보관 위치의 ${ASK}`, value: "B-14", line: 377 }),
  lineTask(19, { id: "meeting-date-66", name: "주간회의.md", content: build(70, meeting, { 65: "- 다음 회의 후보: 10월 2일", 66: "- 다음 회의 확정: 10월 9일" }), prompt: `주간회의 문서에서 확정된 다음 회의 날짜의 ${ASK}`, value: "10월 9일", line: 66 }),
  lineTask(20, { id: "log-user-118", name: "access.log", content: build(150, log, { 118: "2026-08-07 22:41:00 AUDIT login denied user=kimdohyun reason=locked" }), prompt: `access.log 에서 로그인이 거부된 사용자 이름의 ${ASK}`, value: "kimdohyun", line: 118 }),
  lineTask(21, { id: "english-limit-77", name: "quota.md", content: build(100, english, { 76: "Draft quota (rejected): 250 requests per minute.", 77: "Approved quota: 400 requests per minute." }), prompt: `In quota.md, what is the approved quota? Give the value and the line number.`, value: "400", line: 77 }),
  lineTask(22, { id: "prose-address-19", name: "안내문.md", content: build(35, prose, { 19: "행사 장소: 세종대로 175 본관 3층" }), prompt: `안내문에서 장소 주소의 ${ASK}`, value: "세종대로 175", line: 19 }),
  lineTask(23, { id: "config-flag-248", name: "features.conf", content: build(260, config, { 248: "enable_offline_sync = true" }), prompt: `features.conf 에서 enable_offline_sync ${ASK}`, value: "true", line: 248 }),
  lineTask(24, { id: "crlf-late-205", name: "로그요약.txt", content: build(220, (i) => `요약 ${i}: 특이 사항 없음`, { 205: "최대 지연: 1840ms (09:12 발생)" }, "\r\n"), prompt: `로그요약에서 최대 지연 값의 ${ASK}`, value: "1840", line: 205 }),
];

/** 값만 묻는 과제 — 행 번호 형식 변경이 값 답변을 해치지 않는지 본다. */
export const VALUE_ONLY_TASKS: LineCitationTask[] = [
  { id: "value-warranty", kind: "value", files: [{ id: uuid(201), name: "보증서.md", content: build(90, prose, { 71: "무상 보증 기간: 26개월" }) }], prompt: "보증서에서 무상 보증 기간만 짧게 답해줘.", value: "26개월" },
  { id: "value-room", kind: "value", files: [{ id: uuid(202), name: "시설.md", content: build(40, meeting, { 22: "- 결정 사항: 교육실은 7층 704호" }) }], prompt: "시설 문서에서 교육실 호실만 답해줘.", value: "704호" },
  { id: "value-threshold", kind: "value", files: [{ id: uuid(203), name: "alert.conf", content: build(150, config, { 120: "cpu_alert_threshold = 93" }) }], prompt: "alert.conf 의 cpu_alert_threshold 값만 답해줘.", value: "93" },
  { id: "value-english-codename", kind: "value", files: [{ id: uuid(204), name: "project.md", content: build(80, english, { 44: "Codename: Juniper Falls" }) }], prompt: "In project.md, what is the codename? Answer with the codename only.", value: "Juniper Falls" },
  { id: "value-csv-score", kind: "value", files: [{ id: uuid(205), name: "평가.csv", content: build(200, csv, { 1: "코드,지역,점수,상태", 177: "1177,광주,64,재평가" }) }], prompt: "평가.csv 에서 광주의 점수만 답해줘.", value: "64" },
  { id: "value-near-dup", kind: "value", files: [{ id: uuid(206), name: "요금.md", content: build(60, (i) => `항목 ${i}: 변동 없음`, { 41: "기본요금(구): 12,000원", 42: "기본요금(신): 13,500원" }) }], prompt: "요금 문서에서 새 기본요금만 답해줘.", value: "13,500" },
  { id: "value-crlf", kind: "value", files: [{ id: uuid(207), name: "공지.txt", content: build(80, (i) => `공지 ${i}: 일반 안내`, { 63: "점검 시간: 새벽 2시부터 4시까지" }, "\r\n") }], prompt: "공지에서 점검 시간만 답해줘.", value: "2시" },
  { id: "value-log", kind: "value", files: [{ id: uuid(208), name: "batch.log", content: build(120, log, { 97: "2026-08-12 04:00:00 INFO batch finished rows=48211" }) }], prompt: "batch.log 에서 처리된 rows 값만 답해줘.", value: "48211" },
];

// ── 채점기(결과를 보기 전에 고정) ─────────────────────────────────────────────
const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
/**
 * 답변이 인용한 행 번호를 뽑는다. "40행", "40번째 줄", "40번 줄", "40줄", "line 40", "L40", "40|" 형태.
 * "행사"처럼 행으로 시작하는 낱말은 제외한다.
 */
export function citedLines(text: string): number[] {
  const found = new Set<number>();
  // 범위("46~47행", "lines 46-47")는 양끝을 모두 인용한 것으로 본다.
  for (const match of text.matchAll(/(\d{1,5})\s*[~–—-]\s*(\d{1,5})\s*(?:번째\s*|번\s*)?(?:행(?!사)|줄|라인)/g)) { found.add(Number(match[1])); found.add(Number(match[2])); }
  for (const match of text.matchAll(/\blines?\s*(\d{1,5})\s*[~–—-]\s*(\d{1,5})/gi)) { found.add(Number(match[1])); found.add(Number(match[2])); }
  const patterns = [
    /(\d{1,5})\s*(?:번째\s*|번\s*)?(?:행(?!사)|줄|라인)/g,
    /\b(?:line|lines|Line|Lines|LINE)\s*#?\s*(\d{1,5})/g,
    /(?:^|[^A-Za-z0-9])L(\d{1,5})\b/g,
    /(?:^|[\s`>])(\d{1,5})\|/gm,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(Number(match[1]));
  return [...found].sort((a, b) => a - b);
}
export interface Grade { pass: boolean; valueOk: boolean; lines: number[]; lineOk: boolean | null }
/**
 * line 과제: 값이 들어 있고, 인용한 행 번호가 하나 이상이며 전부 정답 행이어야 PASS.
 *   (정답 행과 옆 행을 함께 대는 답도 실패 — 가장 흔한 오류가 한 줄 어긋남이기 때문이다.)
 * value 과제: 값이 들어 있으면 PASS. 행 번호는 보지 않는다.
 */
export function grade(task: LineCitationTask, text: string): Grade {
  const valueOk = normalize(text).includes(normalize(task.value));
  const lines = citedLines(text);
  if (task.kind === "value") return { pass: valueOk, valueOk, lines, lineOk: null };
  const lineOk = lines.length > 0 && lines.every((n) => n === task.line);
  return { pass: valueOk && lineOk, valueOk, lines, lineOk };
}
