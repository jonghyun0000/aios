import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), env: vi.fn(), worker: vi.fn(), failures: [] as Array<(job: unknown, error: Error) => void> }));
vi.mock("@aios/shared", async (original) => ({ ...await original<typeof import("@aios/shared")>(), loadEnv: mocks.env }));
vi.mock("../context.js", () => ({ createContext: mocks.context }));
vi.mock("bullmq", () => ({ Worker: mocks.worker, Queue: vi.fn() }));
vi.mock("../server.js", () => ({ buildServer: vi.fn() }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.failures.length = 0;
  mocks.env.mockReturnValue({ LOCAL_WORKSPACE_ROOT: undefined });
  mocks.worker.mockImplementation(() => ({
    name: "fixture",
    on: (event: string, callback: (job: unknown, error: Error) => void) => { if (event === "failed") mocks.failures.push(callback); },
  }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("실제 API/worker 진입점의 합성 오류 로그", () => {
  it.each(["main", "worker"])("%s 초기화 실패는 원문 없이 종료 코드 1을 유지한다", async (entry) => {
    const marker = "SYNTHETIC_ONLY_STARTUP_ERROR";
    mocks.context.mockRejectedValue(Object.assign(new Error(marker), { code: "ECONNREFUSED", config: { token: marker } }));
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    if (entry === "main") await import("../main.js");
    else await import("../worker.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.context).toHaveBeenCalledOnce(); // 환경 대역 실패로 대상 경로를 건너뛰어 통과하지 않는다.
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]![0]).toEqual(expect.any(String));
    const text = String(output.mock.calls[0]![0]);
    expect(text).not.toContain(marker);
    expect(JSON.parse(text).error).toEqual({ type: "Error", code: "ECONNREFUSED" });
  });
  it("DB 연결 전 환경 검사 실패도 비밀 없는 요약으로 종료한다", async () => {
    const marker = "SYNTHETIC_ONLY_CONFIGURATION_ERROR";
    mocks.env.mockImplementation(() => { throw Object.assign(new Error(marker), { config: { token: marker } }); });
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("../main.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.context).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledOnce();
    expect(String(output.mock.calls[0]![0])).not.toContain(marker);
    expect(JSON.parse(String(output.mock.calls[0]![0])).error).toEqual({ type: "Error" });
  });
  it("워커 작업 실패 이벤트도 원문 대신 오류 요약을 기록한다", async () => {
    const marker = "SYNTHETIC_ONLY_JOB_ERROR";
    mocks.context.mockResolvedValue({ redis: {}, bus: { subscribe: async () => {}, stop() {} } });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    // 실제 프로세스의 시그널 상태나 생명주기를 바꾸지 않는다.
    vi.spyOn(process, "on").mockImplementation(() => process);
    await import("../worker.js");
    await vi.waitFor(() => expect(mocks.failures).toHaveLength(2));
    for (const fail of mocks.failures) fail({ id: "fixture-job" }, Object.assign(new Error(marker), { code: "ETIMEDOUT" }));
    const lines = output.mock.calls.map(([text]) => String(text));
    expect(lines.join("")).not.toContain(marker);
    const failures = lines.map(text => JSON.parse(text)).filter(item => item.msg === "job.failed");
    expect(failures).toHaveLength(2);
    for (const failure of failures) expect(failure.extra.error).toEqual({ type: "Error", code: "ETIMEDOUT" });
  });
});
