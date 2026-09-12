/** 한 연결 정리 실패로 다른 정리를 생략하지 않되 실패 사실도 버리지 않는다. */
export async function closeAllResources(resources: Array<() => Promise<unknown> | void>): Promise<void> {
  const results = await Promise.allSettled(resources.map((close) => Promise.resolve().then(close)));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
  if (errors.length) throw new AggregateError(errors, "리소스 정리에 실패했습니다.");
}

/** 진행 중 작업이 DB/Redis를 사용하므로 연결은 모든 워커의 drain 이후 닫는다. */
export async function closeWorkersThenContext(
  workers: Array<{ close(): Promise<void> }>,
  closeContext: () => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(workers.map((worker) => Promise.resolve().then(() => worker.close())));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
  await closeContext().catch((err: unknown) => { errors.push(err); });
  if (errors.length) throw new AggregateError(errors, "작업 처리기 종료 중 저장 또는 연결 정리에 실패했습니다.");
}
