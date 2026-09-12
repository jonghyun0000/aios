// 복구 검증용 실제 자식 프로세스. 운영 워커에서 결함 주입 명령을 노출하지 않는다.
process.on("message", ({ id, sql }) => {
  if (sql === "CRASH") process.exit(42);
  else if (sql === "HANG") return;
  else process.send({ id, rows: [{ value: 9007199254740993n }] });
});
process.on("disconnect", () => process.exit(0));
