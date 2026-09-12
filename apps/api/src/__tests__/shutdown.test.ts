import { describe, expect, it, vi } from "vitest";
import { closeAllResources, closeWorkersThenContext } from "../shutdown.js";

describe("워커 종료 장애 주입", () => {
  it("모든 진행 중 작업이 끝나기 전에는 DB/Redis를 닫지 않는다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const closeContext = vi.fn(async () => { order.push("context"); });
    const closing = closeWorkersThenContext([
      { close: async () => { await gate; order.push("slow worker"); } },
      { close: async () => { order.push("fast worker"); } },
    ], closeContext);
    await Promise.resolve(); await Promise.resolve();
    expect(closeContext).not.toHaveBeenCalled();
    release(); await closing;
    expect(order).toEqual(["fast worker", "slow worker", "context"]);
  });

  it("워커 실패도 다른 작업 drain을 기다리고 오류를 성공으로 삼키지 않는다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const closeContext = vi.fn(async () => {});
    const closing = closeWorkersThenContext([
      { close: async () => { throw new Error("injected worker failure"); } },
      { close: () => gate },
    ], closeContext);
    const rejected = expect(closing).rejects.toThrow("종료 중 저장");
    await Promise.resolve(); await Promise.resolve();
    expect(closeContext).not.toHaveBeenCalled();
    release(); await rejected;
    expect(closeContext).toHaveBeenCalledOnce();
  });

  it("연결 정리 실패를 호출자에게 전파한다", async () => {
    await expect(closeWorkersThenContext([], async () => { throw new Error("injected close failure"); }))
      .rejects.toThrow("연결 정리에 실패");
  });

  it("연결의 비동기 실패와 동기 예외 모두 전파하고 나머지 정리도 끝낸다", async () => {
    const closed: string[] = [];
    const closing = closeAllResources([
      () => { closed.push("child"); throw new Error("injected synchronous close failure"); },
      async () => { closed.push("postgres"); throw new Error("injected postgres close failure"); },
      async () => { closed.push("redis"); },
    ]);
    await expect(closing).rejects.toMatchObject({ message: "리소스 정리에 실패했습니다.", errors: expect.any(Array) });
    expect(closed).toEqual(["child", "postgres", "redis"]);
  });
});
