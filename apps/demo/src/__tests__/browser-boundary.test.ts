import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("공개 데모 브라우저 경계", () => {
  it("런타임 소스에는 네트워크·저장소·동적 실행 호출이 없다", () => {
    const root = resolve(import.meta.dirname, "..");
    const sources = readdirSync(root).filter((name) => !name.startsWith("._") && /\.(ts|tsx)$/.test(name)).map((name) => readFileSync(join(root, name), "utf8")).join("\n");
    const forbidden = /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|eval|Function)\s*\(|\b(?:localStorage|sessionStorage|indexedDB|serviceWorker)\b|node:fs|@aios\/(?:ai|tools|sdk)/;
    expect(sources).not.toMatch(forbidden);
    // 검사기 자체의 결함 주입: 금지 호출을 붙이면 같은 패턴이 실제로 탐지해야 한다.
    expect(`${sources}\nfetch('/should-not-exist')`).toMatch(forbidden);
    expect(`${sources}\nlocalStorage.setItem('x', 'x')`).toMatch(forbidden);
  });
});
