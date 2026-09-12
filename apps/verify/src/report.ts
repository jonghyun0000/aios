/**
 * 공용 검증 리포터. 모든 Phase 하네스가 같은 출력 형식을 쓰도록 한 곳에 둔다.
 * 종료 코드로 CI가 PASS/FAIL을 판정할 수 있게 한다.
 */
export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** 프로바이더 계정 문제인가 (제품 결함이 아니라 검증을 수행할 수 없는 상태) */
function isAccountBlocked(message: string): boolean {
  return /credit balance|insufficient[_ ]quota|billing|payment required|quota exceeded|spending limit/i.test(message);
}

export class Report {
  private checks: Check[] = [];

  constructor(private phase: string) {
    console.log(`\n${"=".repeat(72)}\n${phase}\n${"=".repeat(72)}`);
  }

  section(title: string): void {
    console.log(`\n[${title}]`);
  }

  check(name: string, pass: boolean, detail = ""): boolean {
    this.checks.push({ name, pass, detail });
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    return pass;
  }

  /**
   * 예외를 FAIL로 기록하고 계속 진행 — 한 검사의 실패가 나머지를 막지 않도록.
   *
   * 계정/환경 문제(크레딧 소진, 결제 미설정)는 BLOCKED로 따로 분류한다.
   * 이걸 FAIL로 묶으면 "제품이 고장났다"와 "검증할 돈이 떨어졌다"를 구분할 수 없고,
   * 보고서를 읽는 사람이 잘못된 결론을 내린다.
   */
  async guard(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAccountBlocked(msg)) {
        this.blocked.push({ name, detail: msg.slice(0, 200) });
        console.log(`  BLOCKED  ${name} — provider account issue, not a product failure`);
        return;
      }
      this.check(name, false, `threw: ${msg}`.slice(0, 300));
    }
  }

  private blocked: { name: string; detail: string }[] = [];

  finish(): never {
    const failed = this.checks.filter((c) => !c.pass);
    const verdict = failed.length > 0 ? "FAIL" : this.blocked.length > 0 ? "BLOCKED" : "PASS";
    console.log(`\n${"=".repeat(72)}`);
    console.log(`${this.phase}: ${verdict}  (${this.checks.length - failed.length}/${this.checks.length}` +
      `${this.blocked.length ? `, ${this.blocked.length} blocked` : ""})`);
    if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
    if (this.blocked.length) {
      console.log(`  Could not verify (provider account, not a product defect):`);
      for (const b of this.blocked) console.log(`    ${b.name} — ${b.detail.split("\n")[0]}`);
    }
    console.log("=".repeat(72));
    // BLOCKED도 0이 아닌 코드로 끝낸다: "검증하지 못했다"를 "통과했다"로 집계하면 안 된다.
    // 다만 코드를 2로 구분해 파이프라인이 제품 실패(1)와 환경 차단(2)을 다르게 다룰 수 있게 한다.
    process.exit(failed.length > 0 ? 1 : this.blocked.length > 0 ? 2 : 0);
  }
}
