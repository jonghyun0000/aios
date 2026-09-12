import { BigDataStore } from "@aios/tools";

const config = JSON.parse(process.env.AIOS_BIGDATA_CHILD ?? "{}") as {
  dbPath: string; timeoutMs: number; limits: { memory?: string; threads?: number };
};
const store = new BigDataStore(config.dbPath, config.timeoutMs, config.limits);
const active = new Map<number, AbortController>();
process.on("message", (message: { id?: number; sql?: string; cancel?: number }) => {
  if (message.cancel !== undefined) { active.get(message.cancel)?.abort(); return; }
  if (typeof message.id !== "number" || typeof message.sql !== "string") return;
  const id = message.id;
  const controller = new AbortController();
  active.set(id, controller);
  void store.query(message.sql, controller.signal).then(
    (rows) => { if (process.connected) process.send?.({ id, rows }); },
    (err: unknown) => { if (process.connected) process.send?.({ id, error: err instanceof Error ? err.message : String(err) }); },
  ).finally(() => active.delete(id));
});
// 부모 API가 비정상 종료해도 네이티브 자식이 고아로 남지 않게 한다.
process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
