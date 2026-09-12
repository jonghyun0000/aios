// 검증을 안 했거나 다른 소스를 검사한 결과가 PASS가 되지 않도록 선택·집계를 분리한다.
export const DEFAULT_STEPS = ["typecheck", "lint", "unit", "build"];

export function verificationInputs(files) {
  // 결과 설명 문서만 갱신해도 검증 대상 코드가 바뀐 것처럼 보이는 것을 피한다.
  // 앱/패키지 안의 Markdown 템플릿·fixture는 런타임 입력일 수 있어 그대로 포함한다.
  return files.filter(file => !file.path.startsWith("docs/") && !(file.path.endsWith(".md") && !file.path.includes("/")));
}

export function selectVerificationSteps(args, catalog) {
  const ids = catalog.map(step => step.id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id)) throw new Error("검증 단계 정의가 잘못되었습니다.");
  if (args.length === 1 && ["--help", "--list"].includes(args[0])) return { action: args[0].slice(2), steps: [] };
  const full = args.includes("--legacy-full");
  const destructive = args.includes("--allow-destructive-phase8");
  const report = args.includes("--report");
  const flags = new Set(["--legacy-full", "--allow-destructive-phase8", "--report"]);
  const requested = args.filter(arg => !flags.has(arg));
  if (new Set(args).size !== args.length || requested.some(id => !ids.includes(id)) || (full && requested.length)) throw new Error("알 수 없거나 중복된 검증 단계/옵션입니다. --list로 확인하세요.");
  const selected = full ? ids : requested.length ? requested : DEFAULT_STEPS;
  if (!selected.length || selected.some(id => !ids.includes(id))) throw new Error("검증할 단계가 없습니다.");
  if (selected.includes("phase8") && !destructive) throw new Error("phase8에는 DB·컨테이너 정리가 있습니다. 격리 환경을 확인한 뒤 --allow-destructive-phase8을 명시해야 합니다.");
  if (destructive && !selected.includes("phase8")) throw new Error("파괴적 시험 허용은 phase8 선택에만 사용합니다.");
  return { action: "run", steps: catalog.filter(step => selected.includes(step.id)), report };
}

export function summarizeVerification(results, { sourceChanged = false } = {}) {
  const count = status => results.filter(result => result.status === status).length;
  const counts = { passed: count("PASS"), failed: count("FAIL"), blocked: count("BLOCKED"), skipped: count("SKIP") };
  const malformed = results.some(result => !["PASS", "FAIL", "BLOCKED", "SKIP"].includes(result.status));
  // SKIP은 의도적으로 생략된 경우도 있지만 ‘선택한 범위 전체를 검증했다’는 의미는 아니다.
  const verdict = counts.failed || malformed ? "FAIL" : sourceChanged ? "SOURCE_CHANGED" : !results.length || counts.blocked || counts.skipped ? "INCOMPLETE" : "PASS";
  return { verdict, ...counts, sourceChanged, exitCode: verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2 };
}
