import { test, expect, type Page } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

/**
 * 접근성 트리 검사.
 *
 * 스크린리더를 직접 들을 수는 없다(음성 출력이고, NVDA 는 Windows 전용이다).
 * 대신 **스크린리더가 실제로 소비하는 데이터**인 접근성 트리를 CDP 로 받아 검사한다.
 * 구조·이름·순서가 맞는지는 이것으로 확정할 수 있다.
 * 낭독의 자연스러움은 사람이 들어야 하고, 그 몫은 docs 에 체크리스트로 남겼다.
 */

/**
 * CDP 접근성 노드 중 우리가 쓰는 부분만 선언한다.
 * 프로토콜 전체를 타이핑하지 않는 이유: 우리가 읽는 필드만 계약이고,
 * 나머지를 고정하면 크롬이 필드를 추가할 때마다 이 타입이 거짓말이 된다.
 */
interface AxValue { value?: string }
interface AxProperty { name: string; value?: { value?: string | number | boolean } }
interface AxNode {
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  properties?: AxProperty[];
}

const val = (n: AxNode, k: "role" | "name"): string => n[k]?.value ?? "";
const prop = (n: AxNode, name: string): string | number | boolean | undefined =>
  n.properties?.find((p) => p.name === name)?.value?.value;

async function axTree(page: Page): Promise<AxNode[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
  // 무시된 노드는 스크린리더가 읽지 않는다 — 실제 낭독 대상만 남긴다.
  return nodes.filter((n) => !n.ignored);
}

const ROUTES = ["/", "/data", "/data/1978", "/chat", "/marketplace", "/settings"] as const;

test.describe("접근성 트리", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("모든 화면에 navigation·main 랜드마크가 이름과 함께 있다", async ({ page }) => {
    for (const route of ROUTES) {
      await goRoute(page, route);
      const nodes = await axTree(page);
      const roles = nodes.map((n) => val(n, "role"));
      expect(roles, `${route}: navigation 없음`).toContain("navigation");
      expect(roles, `${route}: main 없음`).toContain("main");

      // 랜드마크가 여럿일 때 이름이 없으면 스크린리더 사용자가 구분하지 못한다.
      const nav = nodes.find((n) => val(n, "role") === "navigation");
      expect(val(nav!, "name").trim(), `${route}: navigation 에 이름 없음`).not.toBe("");
    }
  });

  test("제목 단계를 건너뛰지 않는다", async ({ page }) => {
    for (const route of ROUTES) {
      await goRoute(page, route);
      const nodes = await axTree(page);
      const levels = nodes
        .filter((n) => val(n, "role") === "heading")
        .map((n) => Number(prop(n, "level") ?? 0));
      expect(levels.length, `${route}: 제목이 없다`).toBeGreaterThan(0);
      // h1 → h3 처럼 건너뛰면 스크린리더 사용자가 구조를 잃는다.
      const skips = levels.slice(1)
        .map((lv, i) => (lv > levels[i]! + 1 ? `h${levels[i]}→h${lv}` : null))
        .filter(Boolean);
      expect(skips, `${route}: 제목 단계 건너뜀`).toHaveLength(0);
    }
  });

  test("낭독 대상 중 이름 없는 인터랙티브 요소가 없다", async ({ page }) => {
    const roles = ["button", "link", "textbox", "combobox", "checkbox"];
    for (const route of ROUTES) {
      await goRoute(page, route);
      const nodes = await axTree(page);
      const unnamed = nodes
        .filter((n) => roles.includes(val(n, "role")) && !val(n, "name").trim())
        .map((n) => val(n, "role"));
      expect(unnamed, `${route}: 이름 없는 요소`).toHaveLength(0);
    }
  });

  test("검색 결과 변화가 낭독된다", async ({ page }) => {
    await goRoute(page, "/data");
    // 조작이 반영됐는지 알 수 없으면 사용자는 화면이 멈춘 줄 안다.
    const status = page.locator('[role=status][aria-live=polite]').first();
    await expect(status).toContainText(/개 중/);
    const before = await status.textContent();
    await page.getByRole("button", { name: "다음" }).click();
    await expect(status).not.toHaveText(before ?? "");
  });
});

test.describe("접근성 — 동적 알림", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("채팅 상태 변화가 순서대로 낭독된다", async ({ page }) => {
    test.setTimeout(300_000); // 로컬 7B 모델은 느리다
    await goRoute(page, "/chat");

    // 스트리밍 텍스트에 aria-live 를 직접 걸면 글자가 늘 때마다 문장 전체를
    // 다시 읽어 침묵보다 나쁘다. 그래서 '상태 변화'만 알린다 — 그 순서를 고정한다.
    const announced: string[] = [];
    await page.exposeFunction("__announce", (t: string) => { announced.push(t); });
    await page.evaluate(() => {
      const el = document.querySelector("[role=status][aria-live]");
      if (!el) return;
      // exposeFunction 이 window 에 붙여 준 함수. 타입 선언이 없으므로 좁게 단언한다.
      const w = window as unknown as { __announce: (t: string) => void };
      const announce = (t: string) => { w.__announce(t); };
      new MutationObserver(() => {
        const t = (el.textContent ?? "").trim();
        if (t) announce(t);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });

    await page.getByLabel("메시지 입력").fill("1+1은? 숫자만 답해.");
    await page.getByRole("button", { name: "전송" }).click();

    // 여기서 곧장 '전송으로 돌아왔는가'를 기다리면 안 된다.
    // 클릭 직후 React가 아직 리렌더하기 전이라 버튼은 여전히 "전송"이고,
    // 조건이 **즉시 참**이 되어 스트림을 기다리지 않고 통과한다.
    // 실제로 그렇게 통과했다가, 모델이 느린 실행에서만 실패하는 플래키가 됐다.
    // 그래서 먼저 "중단"으로 바뀌는 것을 보고(=스트림 시작),
    // 그 다음에 "전송"으로 돌아오는 것을 기다린다(=스트림 종료).
    const composerBtn = page.locator(".composer button");
    await expect(composerBtn).toHaveText("중단");
    await expect(composerBtn).toHaveText("전송", { timeout: 280_000 });
    await page.waitForTimeout(1500);

    const unique = [...new Set(announced)];
    expect(unique[0], "요청 시작이 알려지지 않았다").toMatch(/응답을 기다리는 중/);
    expect(unique.at(-1), "완료가 알려지지 않았다").toMatch(/완료|실패|중단/);
  });
});
