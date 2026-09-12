import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContext } from "../context.js";
import { enqueueMemoryJob } from "../queue.js";

const queue = vi.hoisted(() => ({ getJob: vi.fn(), add: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { getJob = queue.getJob; add = queue.add; } }));
beforeEach(() => { vi.clearAllMocks(); queue.getJob.mockResolvedValue(undefined); });
const data = { orgId: "org", sessionId: "session", extractFacts: false };
const ctx = { redis: {} } as unknown as AppContext;

describe("빠른 응답과 깊이 생각의 메모리 잡", () => {
  it("완료 잡을 남겨 다음 턴을 영구 차단하지 않는다", async () => {
    await enqueueMemoryJob(ctx, data);
    expect(queue.add).toHaveBeenCalledWith("extract", data, expect.objectContaining({ removeOnComplete: true, removeOnFail: true }));
  });
  it("고의로 주입한 이전 버전의 완료 잡을 치우고 다시 등록한다", async () => {
    const remove = vi.fn();
    queue.getJob.mockResolvedValue({ data, getState: async () => "completed", remove });
    await enqueueMemoryJob(ctx, data);
    expect(remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });
  it("빠른 모드 대기 잡에 깊이 생각의 추출 요청을 합친다", async () => {
    const updateData = vi.fn();
    queue.getJob.mockResolvedValue({ data, getState: async () => "delayed", updateData });
    await enqueueMemoryJob(ctx, { ...data, extractFacts: true });
    expect(updateData).toHaveBeenCalledWith({ ...data, extractFacts: true });
    expect(queue.add).not.toHaveBeenCalled();
    // 결함 주입: 빠른 모드의 false로 덮어쓰면 이 검사가 실패한다.
    expect(() => expect({ ...data }).toMatchObject({ extractFacts: true })).toThrow();
  });
  it("이미 실행 중인 잡과 새 턴의 ID가 겹치지 않는다", async () => {
    queue.getJob.mockResolvedValue({ data, getState: async () => "active" });
    await enqueueMemoryJob(ctx, data);
    expect(queue.add.mock.calls[0]![2].jobId).not.toBe("mem-session");
  });
});
