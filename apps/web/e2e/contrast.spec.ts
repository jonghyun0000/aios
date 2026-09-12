import { test, expect } from "@playwright/test";
import { login, goRoute } from "./helpers.js";

/**
 * 색 대비 자동 측정 (WCAG 2.1).
 *
 * 지금까지 접근성은 구조(AX 트리·ARIA·포커스)만 검증했고 **대비는 재지 않았다.**
 * 대비는 눈으로 보면 "읽히긴 하네" 로 넘어가기 쉬운데, 저시력·야외 화면·저품질
 * 디스플레이에서는 그 차이가 읽힘과 못 읽힘을 가른다. 그리고 색은 리팩터링 한 번에
 * 조용히 바뀐다 — 사람이 매번 눈으로 확인할 수 없으므로 자동화해야 한다.
 *
 * 기준 (WCAG 2.1 AA):
 *   일반 텍스트   4.5:1
 *   큰 텍스트     3:1   (24px 이상, 또는 18.66px 이상 + bold)
 *   UI 컴포넌트   3:1   (테두리·포커스 링 등 경계를 이루는 색)
 *
 * 라이트/다크를 모두 잰다. 다크 테마는 라이트에서 잘 나온 색을 반전만 해 만드는 경우가
 * 많아 오히려 대비가 깨지기 쉽다.
 */

const ROUTES = ["/", "/chat", "/data", "/collab", "/marketplace", "/settings"];

/** 브라우저 안에서 도는 측정 코드. 반환값만 밖으로 나온다. */
const COLLECT = `() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  // 반투명 색은 뒤에 깔린 색과 합성해야 실제로 보이는 색이 된다.
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /** 실제로 뒤에 보이는 배경색. 투명한 조상을 계속 거슬러 올라가며 합성한다. */
  const effectiveBg = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 1) return acc;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor);
    const base = body && body.a > 0 ? body : { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, base) : base;
  };

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // sr-only(화면에 안 보이고 스크린리더만 읽는 것)는 대비 대상이 아니다.
    if (el.classList.contains("sr-only")) continue;
    // 자기 자신이 직접 가진 텍스트만 본다. 부모까지 세면 같은 글자를 여러 번 재게 된다.
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (!own) continue;

    const fg = parse(st.color);
    if (!fg || fg.a === 0) continue;
    const bg = effectiveBg(el);
    const composed = fg.a < 1 ? over(fg, bg) : fg;

    const px = parseFloat(st.fontSize);
    const weight = parseInt(st.fontWeight, 10) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(composed, bg);

    const key = st.color + "|" + Math.round(bg.r) + "," + Math.round(bg.g) + "," + Math.round(bg.b) + "|" + px + "|" + weight;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      ratio: Math.round(got * 100) / 100, need, large, px, weight,
      color: st.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(", ") + ")",
      tag: el.tagName.toLowerCase(), cls: el.className || "",
      text: own.slice(0, 40),
    });
  }
  return out;
}`;

for (const scheme of ["light", "dark"] as const) {
  test.describe(`색 대비 — ${scheme} 테마`, () => {
    test.use({ colorScheme: scheme });

    test(`모든 화면의 텍스트가 WCAG AA 를 만족한다 (${scheme})`, async ({ page }) => {
      await login(page);
      const failures: string[] = [];
      let measured = 0;

      for (const route of ROUTES) {
        await goRoute(page, route);
        // 문자열을 그대로 넘기면 Playwright 가 '식'으로 평가해 함수 객체가 반환된다.
        // 즉시 호출로 감싸야 측정 결과가 나온다.
        const rows = await page.evaluate<{
          ratio: number; need: number; large: boolean; px: number; weight: number;
          color: string; bg: string; tag: string; cls: string; text: string;
        }[]>(`(${COLLECT})()`);
        measured += rows.length;
        // 화면별 표본 수와 최악 대비를 항상 남긴다.
        // 통과했다는 사실만으로는 '잘 나왔다'와 '아무것도 못 쟀다'를 구분할 수 없다.
        const worst = rows.reduce((a, b) => (b.ratio - b.need < a.ratio - a.need ? b : a), rows[0]!);
        console.log(`    ${route.padEnd(14)} ${String(rows.length).padStart(3)}개 조합, ` +
          `최저 여유 ${worst.ratio}:1 (필요 ${worst.need}:1) <${worst.tag}> "${worst.text}"`);
        for (const r of rows) {
          if (r.ratio < r.need) {
            failures.push(
              `${route} <${r.tag}${r.cls ? "." + String(r.cls).split(" ")[0] : ""}> ` +
              `${r.ratio}:1 (필요 ${r.need}:1, ${r.px}px/${r.weight}) ` +
              `${r.color} on ${r.bg} — "${r.text}"`,
            );
          }
        }
      }

      // 표본이 0이면 "대비가 완벽함"이 아니라 "아무것도 재지 못함"이다.
      console.log(`  [${scheme}] 총 ${measured}개 색 조합 측정, 위반 ${failures.length}건`);
      expect(measured, "측정된 텍스트가 없다 — 수집기가 동작하지 않았다").toBeGreaterThan(50);
      expect(failures.join("\n"), `${measured}개 조합 측정`).toBe("");
    });
  });
}


/**
 * 비텍스트 대비 (WCAG 2.1 SC 1.4.11) — 3:1.
 *
 * 텍스트만 재면 절반이다. 포커스 링이 배경에 묻히면 **키보드 사용자가 자기가 어디 있는지
 * 알 수 없고**, 입력 필드 테두리가 묻히면 어디를 눌러야 하는지 알 수 없다.
 * 둘 다 "글자는 잘 보이는데 쓸 수 없는 화면"을 만든다.
 *
 * 포커스 링은 :focus-visible 로만 나오므로 실제로 키보드 포커스를 줘야 측정된다 —
 * CSS 를 읽는 것으로는 확인할 수 없다.
 */
const CONTRAST_FNS = `
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const effectiveBg = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 1) return acc;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor);
    const base = body && body.a > 0 ? body : { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, base) : base;
  };
`;

for (const scheme of ["light", "dark"] as const) {
  test.describe(`비텍스트 대비 — ${scheme} 테마`, () => {
    test.use({ colorScheme: scheme });

    test(`포커스 표시가 배경과 3:1 이상 구분된다 (${scheme})`, async ({ page }) => {
      await login(page);
      const failures: string[] = [];
      let checked = 0;

      for (const route of ["/", "/data", "/settings"]) {
        await goRoute(page, route);
        // 키보드로 실제 순회한다. 마우스 클릭으로는 :focus-visible 이 켜지지 않는다.
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press("Tab");
          const info = await page.evaluate<{
            tag: string; label: string; visible: boolean; width: number;
            style: string; shadow: boolean; ratio: number | null; color: string; bg: string;
          } | null>(`(() => {
            ${CONTRAST_FNS}
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const st = getComputedStyle(el);
            const bg = effectiveBg(el.parentElement || el);
            const width = parseFloat(st.outlineWidth) || 0;
            const oc = parse(st.outlineColor);
            const sh = st.boxShadow && st.boxShadow !== "none";
            // 아웃라인도 그림자도 없으면 포커스가 보이지 않는다는 뜻이다.
            const visible = (width > 0 && st.outlineStyle !== "none") || sh;
            return {
              tag: el.tagName.toLowerCase(),
              label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30),
              visible, width, style: st.outlineStyle, shadow: sh,
              ratio: oc && width > 0 ? Math.round(ratio(oc.a < 1 ? over(oc, bg) : oc, bg) * 100) / 100 : null,
              color: st.outlineColor, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(", ") + ")",
            };
          })()`);
          if (!info) continue;
          checked++;
          if (!info.visible) {
            failures.push(`${route} <${info.tag}> "${info.label}" — 포커스 표시가 없다 (outline none, shadow none)`);
          } else if (info.ratio !== null && info.ratio < 3) {
            failures.push(
              `${route} <${info.tag}> "${info.label}" — 포커스 링 ${info.ratio}:1 (필요 3:1) ` +
              `${info.color} on ${info.bg}`);
          }
        }
      }
      console.log(`  [${scheme}] 포커스 가능 요소 ${checked}개 확인, 위반 ${failures.length}건`);
      expect(checked, "포커스를 받은 요소가 없다 — Tab 순회가 동작하지 않았다").toBeGreaterThan(20);
      expect(failures.join("\n")).toBe("");
    });
  });
}
