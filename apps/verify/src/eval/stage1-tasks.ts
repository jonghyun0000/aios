import { TASKS, type TextTask } from "./tasks.js";
import { satisfies } from "./sandbox.js";
import type { ChatMessage } from "@aios/shared";

export interface StageTask { id: string; category: string; prompt: string; history?: ChatMessage[]; check(this: void, out: string): boolean }
const exact = (id: string, category: string, prompt: string, expected: string): StageTask => ({ id, category, prompt, check: (out) => out.trim() === expected });
const ko = (id: string, prompt: string, word: RegExp): StageTask => ({ id, category: "korean", prompt, check: (o) => /[가-힣]/.test(o) && !/[一-鿿぀-ヿ]/.test(o) && word.test(o) });
export const STAGE_TASKS: StageTask[] = [
  // 이전에 사용한 9문제를 그대로 포함한다. 시점 의존 국가 문제·도구 실행 평가는 별도다.
  ...(TASKS.filter((t): t is TextTask => t.kind === "text" && t.id !== "precision.negation")),
  ...[
    ["precedence", "12 + 6 * 3", "30"], ["parentheses", "(12 + 6) * 3", "54"],
    ["decimal", "0.1 + 0.2", "0.3"], ["negative", "-7 * 8 + 9", "-47"],
    ["division", "144 / 12", "12"], ["fraction", "1 / 3 + 1 / 6", "0.5"],
    ["large", "9007199254740993 + 1", "9007199254740994"], ["nested", "(8 - (3 + 1)) * 7", "28"],
    ["decimal-product", "12.5 * 0.8", "10"], ["zero", "17 * 0 + 5", "5"],
    ["unicode", "81 ÷ 9 × 2", "18"], ["unary", "-3 * -4", "12"],
  ].map(([id, prompt, expected]) => exact(`arithmetic.${id}`, "arithmetic", `${prompt!}는? 다른 설명 없이 정답 숫자만 답하세요.`, expected!)),
  exact("format.csv", "format", "Reply with exactly this CSV and nothing else:\nname,age\nKim,30", "name,age\nKim,30"),
  exact("format.lower", "format", "Convert HELLO to lowercase. Reply with only the converted word.", "hello"),
  exact("format.array", "format", 'Reply with exactly [3,2,1] without spaces or code fences.', "[3,2,1]"),
  exact("format.extract", "format", "Text: order id is AB-123. Reply with only the order id.", "AB-123"),
  exact("format.sort", "format", "Sort apple, cherry, banana alphabetically. Reply exactly as comma-separated words without spaces.", "apple,banana,cherry"),
  ko("korean.greeting", "처음 만난 동료에게 한 문장으로 인사해줘.", /안녕|반갑|만나/),
  ko("korean.translate", "'Thank you'를 자연스러운 한국어로 번역해줘. 번역만 답해줘.", /감사|고마/),
  ko("korean.summary", "다음 내용을 한 문장으로 요약해줘: 회의는 월요일에서 화요일로 변경되었으며 장소는 그대로입니다.", /화요일/),
  ko("korean.definition", "백업이 무엇인지 쉬운 한국어로 한 문장으로 설명해줘.", /복사|보관|저장|복구/),
  ...[
    ["syllogism", "Logic: All larks are birds. All birds are animals. Are all larks animals? Reply only YES or NO.", "YES"],
    ["converse", "Logic: All cats are animals. Does that imply all animals are cats? Reply only YES or NO.", "NO"],
    ["ordering", "Logic: Ana is taller than Bo. Bo is taller than Cy. Who is shortest? Reply only Ana, Bo, or Cy.", "Cy"],
    ["set", "Solve: A={1,2,3}, B={3,4}. List their intersection as exactly one number.", "3"],
    ["percentage", "Calculate: A shirt costs 200 before a 15 percent discount. What is the discounted price? Reply only the number.", "170"],
    ["ratio", "Solve: 3 notebooks cost 12 dollars. At the same unit price, what do 5 notebooks cost? Reply only the number.", "20"],
    ["probability", "Calculate: A fair six-sided die is rolled once. What fraction of outcomes are even? Reply exactly as a reduced fraction a/b.", "1/2"],
    ["negation", "Logic: It is false that all boxes are red. Must there be a non-red box? Reply only YES or NO.", "YES"],
    ["boundary", "Solve: How many integers x satisfy 2 < x and x <= 5? Reply only the number.", "3"],
    ["unknown", "Logic: Ana is older than Bo. Cy is older than Bo. Can we determine who is older between Ana and Cy? Reply only YES or NO.", "NO"],
  ].map(([id, prompt, expected]) => exact(`reasoning.${id}`, "reasoning", prompt!, expected!)),
  ...[
    { name: "clamp", spec: "clamp(x:number, lo:number, hi:number):number returning x clamped to inclusive bounds lo and hi", cases: [{ args: [-2,0,10], expect: 0 }, { args: [20,0,10], expect: 10 }, { args: [5,0,10], expect: 5 }] },
    { name: "countTrue", spec: "countTrue(xs:boolean[]):number counting only true entries", cases: [{ args: [[true,false,true]], expect: 2 }, { args: [[]], expect: 0 }] },
    { name: "firstOrNull", spec: "firstOrNull(xs:number[]):number|null returning the first element or null for an empty array", cases: [{ args: [[0,2]], expect: 0 }, { args: [[]], expect: null }] },
    { name: "isEven", spec: "isEven(x:number):boolean checking whether an integer is even", cases: [{ args: [-2], expect: true }, { args: [0], expect: true }, { args: [3], expect: false }] },
    { name: "sumPositive", spec: "sumPositive(xs:number[]):number summing strictly positive numbers", cases: [{ args: [[-1,0,2,4]], expect: 6 }, { args: [[]], expect: 0 }] },
  ].map(({ name, spec, cases }) => ({ id: `code.${name}`, category: "code", prompt: `Write a TypeScript function ${spec}. Reply only with code, no fences.`, check: (out: string) => satisfies(out, name, cases) })),
  ...[
    ["project", "내 프로젝트 이름은 자작나무입니다.", "방금 말한 프로젝트 이름만 답해줘.", "자작나무"],
    ["color", "내가 고른 색상은 파랑입니다.", "내가 고른 색상만 답해줘.", "파랑"],
    ["correction", "회의 요일은 월요일이 아니라 목요일입니다.", "회의 요일만 답해줘.", "목요일"],
    ["identifier", "이번 문서 식별자는 ZX-804입니다.", "방금 문서 식별자만 답해줘.", "ZX-804"],
    ["preference", "이 대화에서는 답변을 한국어로 해줘.", "What language did I ask you to use? Reply with only its Korean name.", "한국어"],
  ].map(([id, statement, prompt, expected]) => ({ ...exact(`context.${id}`, "context", prompt!, expected!), history: [{ role: "user" as const, content: statement! }, { role: "assistant" as const, content: "확인했습니다." }] })),
];
if (STAGE_TASKS.length !== 50) throw new Error(`Expected 50 tasks, got ${STAGE_TASKS.length}`);
