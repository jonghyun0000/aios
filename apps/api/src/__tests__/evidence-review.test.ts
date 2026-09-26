import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AiosError } from "@aios/shared";
import type { AppContext } from "../context.js";
import { registerChatRoutes } from "../routes/chat.js";
import { registerWorkspaceRoutes } from "../routes/workspace.js";
import { evidenceStatus, numberLines, referenceChunks, type MessageEvidence, type ReferenceFile } from "../workspace.js";

const SESSION = "10000000-0000-4000-8000-000000000001";
const MESSAGE = "10000000-0000-4000-8000-000000000002";
const FILE = "10000000-0000-4000-8000-000000000003";
const OTHER_FILE = "10000000-0000-4000-8000-000000000004";

const planContent = [...Array.from({ length: 39 }, (_, i) => `${i + 1}번째 줄: 일반 내용`), "출시일: 2026-11-03", "담당: 김하늘"].join("\n");

describe("구간 선택이 근거로 저장할 원문을 돌려준다", () => {
  it("파일 ID와 모델에 보낸 블록 원문을 같은 순서로 준다", () => {
    const result = referenceChunks([{ id: FILE, name: "제품계획.md", content: planContent }], "출시일은?");
    expect(result.sources[0]).toMatchObject({ id: "R1", fileId: FILE, fileName: "제품계획.md", startLine: 1, endLine: 41 });
    expect(result.excerpts).toHaveLength(result.sources.length);
    // 모델 입력에는 실제 행 번호가 붙고(docs/40), 저장 원문에는 붙지 않는다.
    expect(result.chunks[0]).toContain(JSON.stringify(numberLines(result.excerpts[0]!, 1)));
    expect(result.chunks[0]).toContain("40| 출시일: 2026-11-03");
    expect(result.excerpts[0]).toContain("출시일: 2026-11-03"); expect(result.excerpts[0]).not.toContain("40|");
  });

  it("1000자를 넘는 줄은 조각으로 전달되고, 조각도 현재 파일과 대조된다", () => {
    const content = `머리말\n${"가".repeat(2500)}\n꼬리말`;
    const result = referenceChunks([{ id: FILE, name: "긴줄.txt", content }], "가가");
    const pieces = result.sources.map((source, i) => ({ ...source, excerpt: result.excerpts[i]! }));
    expect(pieces.some((piece) => piece.startLine === 2 && piece.endLine === 2 && piece.excerpt.length === 1000)).toBe(true);
    for (const piece of pieces) {
      const view = evidenceStatus(piece, { name: "긴줄.txt", content, deleted_at: null }, false);
      expect(view.match).toBe(true);
    }
    const part = pieces.find((piece) => piece.excerpt.length === 1000)!;
    expect(evidenceStatus(part, { name: "긴줄.txt", content, deleted_at: null }, false).partial).toBe(true);
  });
});

describe("근거와 현재 파일의 대조", () => {
  const source = { id: "R1", fileId: FILE, fileName: "제품계획.md", startLine: 40, endLine: 41, excerpt: "출시일: 2026-11-03\n담당: 김하늘\n" };
  const file = { name: "제품계획.md", content: planContent, deleted_at: null };

  it("연결 중인 파일: 일치, 앞뒤 3행 문맥, 인용 행 표시", () => {
    const view = evidenceStatus(source, file, false);
    expect(view).toMatchObject({ status: "attached", match: true, partial: false, newerSameName: false });
    expect(view.context!.lines.map((line) => line.number)).toEqual([37, 38, 39, 40, 41]);
    expect(view.context!.lines.filter((line) => line.cited).map((line) => line.number)).toEqual([40, 41]);
    expect(view.source).not.toHaveProperty("excerpt");
  });

  it("같은 행 번호에 다른 내용이면 불일치로 알린다(성공으로 숨기지 않는다)", () => {
    const view = evidenceStatus({ ...source, startLine: 39, endLine: 40 }, file, false);
    expect(view.match).toBe(false);
    expect(evidenceStatus({ ...source, startLine: 90, endLine: 91 }, file, false).match).toBe(false);
  });

  it("연결 해제된 파일은 전달 원문만 주고 파일 문맥을 열지 않는다", () => {
    const view = evidenceStatus(source, { ...file, deleted_at: new Date() }, true);
    expect(view).toMatchObject({ status: "detached", match: null, context: null, newerSameName: true, excerpt: source.excerpt });
  });

  it("파일 행이 없으면 missing", () => {
    expect(evidenceStatus(source, undefined, false)).toMatchObject({ status: "missing", match: null, context: null });
  });

  it("문맥 행 수에 상한이 있다", () => {
    const content = "\n".repeat(999);
    const view = evidenceStatus({ ...source, startLine: 1, endLine: 1000, excerpt: "\n".repeat(1000) }, { ...file, content }, false);
    expect(view.match).toBe(true);
    expect(view.context!.lines).toHaveLength(300); expect(view.context!.truncated).toBe(true);
  });
});

function readFixture(opts: { role?: "viewer" | "member"; content?: unknown; file?: Record<string, unknown> | null; newer?: number } = {}) {
  const query = vi.fn(async (sql: string, _params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
    if (sql.includes("from messages m join sessions s")) return { rows: opts.content === undefined ? [] : [{ content: opts.content, created_at: new Date("2026-09-27T00:00:00Z"), project_id: null }] };
    if (sql.includes("select name, content, deleted_at from workspace_files")) return { rows: opts.file ? [opts.file] : [] };
    if (sql.includes("count(*)::int as n from workspace_files")) return { rows: [{ n: opts.newer ?? 0 }] };
    return { rows: [] };
  });
  const app = Fastify();
  app.addHook("preHandler", async (req) => { req.auth = { orgId: "org", role: opts.role ?? "member", via: "local", scopes: ["*"] }; });
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof AiosError ? err.status : (err as { name?: string }).name === "ZodError" ? 400 : 500).send({ error: (err as Error).message }));
  registerWorkspaceRoutes(app, { pool: { query } } as unknown as AppContext);
  return { app, query };
}
const evidence: MessageEvidence = { version: 1, referenceMode: "matched", excerpted: false, files: [{ id: FILE, name: "제품계획.md" }],
  sources: [{ id: "R1", fileId: FILE, fileName: "제품계획.md", startLine: 40, endLine: 41, excerpt: "출시일: 2026-11-03\n담당: 김하늘\n" }] };
const url = (source = "R1", message = MESSAGE, session = SESSION) => `/v1/sessions/${session}/messages/${message}/evidence/${source}`;

describe("근거 열람 API", () => {
  it("viewer도 읽을 수 있고, 조직·대화·휴지통·답변 조건으로만 조회한다", async () => {
    const f = readFixture({ role: "viewer", content: { text: "답", evidence }, file: { name: "제품계획.md", content: planContent, deleted_at: null }, newer: 1 });
    try {
      const res = await f.app.inject(url());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "attached", match: true, newerSameName: true, source: { fileId: FILE, startLine: 40 } });
      const [messageSql, messageParams] = f.query.mock.calls[0]!;
      expect(messageSql).toContain("s.org_id = $3"); expect(messageSql).toContain("s.deleted_at is null"); expect(messageSql).toContain("m.role = 'assistant'");
      expect(messageParams).toEqual([MESSAGE, SESSION, "org"]);
      expect(f.query.mock.calls[1]![1]).toEqual([FILE, "org"]);
      expect(f.query.mock.calls.every(([sql]) => /^\s*select/i.test(sql))).toBe(true);
    } finally { await f.app.close(); }
  });

  it("다른 조직·휴지통·없는 메시지는 404", async () => {
    const f = readFixture({ content: undefined });
    try { expect((await f.app.inject(url())).statusCode).toBe(404); expect(f.query).toHaveBeenCalledTimes(1); } finally { await f.app.close(); }
  });

  it("잘못된 ID·구간 ID는 DB 전에 400", async () => {
    const f = readFixture({ content: { text: "답", evidence } });
    try {
      for (const target of [url("R1", "bad"), url("R1", MESSAGE, "undefined"), url("R0"), url("x1"), url("R1000")]) expect((await f.app.inject(target)).statusCode).toBe(400);
      expect(f.query).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it("근거가 없는 옛 메시지·깨진 근거·없는 구간은 404(500 아님)", async () => {
    for (const content of [{ text: "옛 답변" }, { text: "깨짐", evidence: { version: 1, sources: [{ id: "R1", fileId: "nope" }] } }, "문자열 content", null]) {
      const f = readFixture({ content });
      try { expect((await f.app.inject(url())).statusCode).toBe(404); } finally { await f.app.close(); }
    }
    const f = readFixture({ content: { text: "답", evidence } });
    try { expect((await f.app.inject(url("R2"))).statusCode).toBe(404); } finally { await f.app.close(); }
  });

  it("연결 해제된 파일은 본문을 돌려주지 않는다", async () => {
    const f = readFixture({ content: { text: "답", evidence }, file: { name: "제품계획.md", content: "비밀 아닌 다른 내용", deleted_at: new Date() } });
    try {
      const body = (await f.app.inject(url())).json<{ status: string; context: unknown; excerpt: string }>();
      expect(body.status).toBe("detached"); expect(body.context).toBeNull(); expect(JSON.stringify(body)).not.toContain("비밀 아닌 다른 내용");
    } finally { await f.app.close(); }
  });
});

describe("채팅 라우트가 실제로 모델에 들어간 구간만 답변과 함께 저장한다", () => {
  function chatFixture(files: ReferenceFile[], contextWindow = 8192) {
    const inserts: Array<{ role: string; content: Record<string, unknown> }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("select p.id as project_id")) return { rows: [{ project_id: null, name: null }] };
      if (sql.includes("from workspace_files")) return { rows: files };
      if (sql.includes("insert into messages")) inserts.push({ role: params[2] as string, content: JSON.parse(params[3] as string) });
      return { rows: [] };
    });
    const stream = vi.fn(async function* () { yield { type: "text_delta" as const, text: "2026-11-03" }; yield { type: "done" as const, stopReason: "end_turn" }; });
    const ctx = {
      env: { LOCAL_LLM_BASE_URL: "http://127.0.0.1:11434/v1", LOCAL_LLM_CONTEXT: contextWindow }, pool: { query }, router: { stream },
      memory: { record: async () => {}, buildContext: async () => ({ history: [], stmSummary: null, facts: [] }) },
      retriever: { format: () => [] }, bus: { publish: async () => {} }, usage: { bind: () => {} },
    } as unknown as AppContext;
    const app = Fastify();
    app.addHook("preHandler", async (req) => { req.auth = { orgId: "org", via: "local", role: "member", scopes: ["*"] }; });
    registerChatRoutes(app, ctx);
    const send = (content: string) => app.inject({ method: "POST", url: `/v1/sessions/${SESSION}/messages`, payload: { content, mode: "fast", tools: { enabled: false }, context: { useMemory: false, useLongTermMemory: false, useRag: false } } });
    return { app, inserts, send };
  }

  it("근거·전달 원문·조회한 파일 목록을 assistant 메시지에 저장하고 사용자 메시지에는 넣지 않는다", async () => {
    const f = chatFixture([{ id: FILE, name: "제품계획.md", content: planContent }, { id: OTHER_FILE, name: "무관.md", content: "관계없는 메모" }]);
    try {
      expect((await f.send("출시일은?")).statusCode).toBe(200);
      const user = f.inserts.find((row) => row.role === "user")!; const assistant = f.inserts.find((row) => row.role === "assistant")!;
      expect(user.content).not.toHaveProperty("evidence");
      const saved = assistant.content.evidence as MessageEvidence;
      expect(saved.files).toEqual([{ id: FILE, name: "제품계획.md" }, { id: OTHER_FILE, name: "무관.md" }]);
      expect(saved.sources.map((source) => source.fileId)).toEqual([FILE]);
      expect(saved.sources[0]!.excerpt).toContain("출시일: 2026-11-03");
      expect(saved.referenceMode).toBe("matched");
    } finally { await f.app.close(); }
  });

  it("입력 예산으로 잘린 구간은 근거로 저장하지 않는다", async () => {
    const files = Array.from({ length: 4 }, (_, i) => ({ id: `10000000-0000-4000-8000-00000000001${i}`, name: `노트${i}.md`, content: `키워드 ${i}\n${"내용 ".repeat(300)}` }));
    const f = chatFixture(files, 2400);
    try {
      expect((await f.send("키워드")).statusCode).toBe(200);
      const saved = f.inserts.find((row) => row.role === "assistant")!.content.evidence as MessageEvidence;
      expect(saved.sources.length).toBeLessThan(4); expect(saved.excerpted).toBe(true);
    } finally { await f.app.close(); }
  });

  it("연결 파일이 없으면 기존 메시지 형식 그대로 저장한다", async () => {
    const f = chatFixture([]);
    try {
      expect((await f.send("안녕")).statusCode).toBe(200);
      expect(f.inserts.find((row) => row.role === "assistant")!.content).toEqual({ text: "2026-11-03", toolCalls: null });
    } finally { await f.app.close(); }
  });
});

describe("모델 입력의 행 번호 접두어", () => {
  it("블록 시작 행부터 번호를 붙이고 끝 줄바꿈은 빈 행으로 만들지 않는다", () => {
    expect(numberLines("가\n나\n", 120)).toBe("120| 가\n121| 나");
    expect(numberLines("끝 줄바꿈 없음", 7)).toBe("7| 끝 줄바꿈 없음");
    expect(numberLines("\n\n다\n", 3)).toBe("3| \n4| \n5| 다");
  });
  it("CRLF 파일의 \\r 은 원문 그대로 두고 번호만 붙인다", () => expect(numberLines("a\r\nb\r\n", 10)).toBe("10| a\r\n11| b\r"));
  it("긴 줄의 1000자 조각에는 그 줄 번호를 붙인다", () => {
    const content = `머리말\n${"가".repeat(2500)}\n꼬리말`;
    const result = referenceChunks([{ id: FILE, name: "긴줄.txt", content }], "가가");
    const i = result.excerpts.findIndex((excerpt) => excerpt.length === 1000);
    expect(result.chunks[i]).toContain(JSON.stringify(`2| ${"가".repeat(1000)}`));
  });
  it("파일 중간에서 시작하는 블록은 실제 행 번호로 시작한다", () => {
    const content = Array.from({ length: 300 }, (_, i) => (i === 211 ? "비밀번호 교체 주기: 45일" : `잡음 ${i + 1}`)).join("\n");
    const result = referenceChunks([{ id: FILE, name: "운영.md", content }], "교체 주기");
    const hit = result.sources[0]!;
    expect(hit.startLine).toBeGreaterThan(1);
    expect(result.chunks[0]).toContain(`212| 비밀번호 교체 주기: 45일`);
    expect(result.chunks[0]).toContain(`${hit.startLine}| `);
  });
});
