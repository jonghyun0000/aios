import type { ChatMode } from "@aios/shared";

// 명확한 사칙연산만 허용한다. JavaScript 실행/외부 도구/모델 출력의 재해석은 없다.
// 분수로 계산하므로 0.1 + 0.2 같은 입력도 정확하다. 순환소수는 분수로 반환한다.
type Fraction = { n: bigint; d: bigint };
function fraction(n: bigint, d = 1n): Fraction {
  if (d === 0n) throw new Error("0으로 나눌 수 없습니다.");
  if (n.toString().length > 200 || d.toString().length > 200) throw new Error("계산 범위를 초과했습니다.");
  let a = n < 0n ? -n : n; let b = d < 0n ? -d : d;
  while (b) [a, b] = [b, a % b];
  const sign = d < 0n ? -1n : 1n;
  return { n: n / (a || 1n) * sign, d: d / (a || 1n) * sign };
}
function format({ n, d }: Fraction): string {
  let rest = d;
  while (rest % 2n === 0n) rest /= 2n;
  while (rest % 5n === 0n) rest /= 5n;
  if (rest !== 1n) return `${n}/${d}`;
  const sign = n < 0n ? "-" : ""; n = n < 0n ? -n : n;
  let tail = ""; let r = n % d;
  while (r) { r *= 10n; tail += String(r / d); r %= d; }
  return `${sign}${n / d}${tail ? `.${tail}` : ""}`;
}

export function calculate(content: string): { expression: string; text: string; ok: boolean } | null {
  if (content.length > 500) return null;
  if (/^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\+?\d{2,4}-\d{3,4}-\d{4})$/.test(content.trim())) return null;
  let source = content.trim().replace(/(?:Reply with only the number\.|다른 설명 없이 정답 숫자만 답하세요\.|숫자만(?: 답해(?:주세요|줘))?[.!]?)$/i, "").trim();
  source = source.replace(/^(?:What is\s+|Calculate\s+|계산(?:해(?:줘|주세요))?\s*:?\s*)/i, "");
  source = source.replace(/(?:\s*(?:는|은)?\?|\s*(?:을|를)?\s*계산해(?:줘|주세요)[.!]?|\s*=)$/, "").trim();
  source = source.replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-");
  if (!/^[\d.\s()+*/-]+$/.test(source) || !/[+*/-]/.test(source)) return null;
  const tokens = source.match(/\d+(?:\.\d+)?|\.\d+|[()+*/-]/g) ?? [];
  if (tokens.join("") !== source.replace(/\s/g, "") || tokens.length > 80) return null;
  let pos = 0;
  function atom(): Fraction {
    const t = tokens[pos++];
    if (t === "+" || t === "-") { const v = atom(); return { n: t === "-" ? -v.n : v.n, d: v.d }; }
    if (t === "(") { const v = sum(); if (tokens[pos++] !== ")") throw new Error("invalid"); return v; }
    if (!t || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t) || t.length > 40) throw new Error("invalid");
    const [whole, decimal = ""] = t.split(".");
    return fraction(BigInt(`${whole || "0"}${decimal}`), 10n ** BigInt(decimal.length));
  }
  function product(): Fraction {
    let v = atom();
    while (tokens[pos] === "*" || tokens[pos] === "/") {
      const op = tokens[pos++]; const b = atom();
      v = op === "*" ? fraction(v.n * b.n, v.d * b.d) : fraction(v.n * b.d, v.d * b.n);
    }
    return v;
  }
  function sum(): Fraction {
    let v = product();
    while (tokens[pos] === "+" || tokens[pos] === "-") {
      const op = tokens[pos++]; const b = product();
      v = fraction(v.n * b.d + (op === "+" ? 1n : -1n) * b.n * v.d, v.d * b.d);
    }
    return v;
  }
  try {
    const result = sum();
    if (pos !== tokens.length) return null;
    return { expression: source, text: format(result), ok: true };
  } catch (err) {
    // 문법이 모호하면 추론으로 넘긴다. 명확한 정의역 오류는 답을 지어내지 않는다.
    const message = err instanceof Error ? err.message : "invalid";
    return message === "invalid" ? null : { expression: source, text: message, ok: false };
  }
}

export function chooseChatStrategy(content: string, mode: ChatMode, toolsEnabled: boolean) {
  if (mode === "auto" && !toolsEnabled) {
    const calculation = calculate(content);
    if (calculation) return { path: "calculator" as const, reason: "명확한 사칙연산 · 정확 계산", calculation };
  }
  if (mode !== "auto") return { path: mode, reason: "직접 선택한 응답 모드", calculation: null };
  // 출력 포맷 금지 문구는 실제 코딩 요청이 아니다. 이 때문에 JSON 복사가 20초 걸렸다.
  const classified = content.replace(/\bcode fences\b|코드\s*블록/gi, "");
  // 짧은 순수 함수도 모두 추론시키자 같은 정답에 2.3초→132초가 걸렸다.
  // 타입이 명시된 짧은 단일 함수 '작성'만 빠르게; 변경/실행/디버깅/민감 작업은 제외한다.
  const smallFunction = !toolsEnabled && content.length <= 600
    && /\b(?:write|create|implement)\b/i.test(classified)
    && (classified.match(/\bfunction\b/gi)?.length ?? 0) === 1
    && /\bfunction\s+`?\w+\s*\([^)]*\)\s*:\s*(?:number|boolean|string)\b/i.test(classified)
    && !/bug|debug|fix|file|execute|shell|async|concurr|recurs|algorithm|parser|security|auth|encrypt|password|sql|network|http|prove|최적화|검증|보안|복잡/i.test(classified);
  if (smallFunction) return { path: "fast" as const, reason: "짧은 단일 함수 작성 · 빠른 응답", calculation: null };
  // 짧은 번역도 의미 오류가 관측됐다. 길이만으로 단순 작업이라고 판단하지 않는다.
  const complex = toolsEnabled || content.length > 1800 || /```|\b(?:code|function|algorithm|debug|proof|reason|solve|logic|sql|typescript|python|calculate|compare|translate|translation)\b|코드|함수|알고리즘|버그|구현|논리|추론|증명|계산|비교|분석|전략|설계|계획|번역|왜|원인|장단점|이전 대화|장기기억|\d\s*[-+*/×÷^%]/i.test(classified);
  return { path: complex ? "thorough" as const : "fast" as const, reason: complex ? "도구·계산·복잡한 질문 신호 감지" : "짧은 일반 질문 · 현재 대화만 사용", calculation: null };
}
