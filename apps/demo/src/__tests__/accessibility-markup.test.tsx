import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../App.js";

describe("공개 데모 접근성 구조", () => {
  it("체험 제한 안내를 최상위 배너로 제공한다", () => {
    const html = renderToStaticMarkup(<App />);
    const landmark = /<header class="demo-disclosure">[\s\S]*?실제 AI 응답·파일 실행 아님[\s\S]*?<\/header>/;
    expect(html).toMatch(landmark);
    expect(html.replace('<header class="demo-disclosure">', '<div class="demo-disclosure">')).not.toMatch(landmark);
  });

  it("버튼이 비활성화되어도 대화·파일 스크롤 영역에 키보드로 접근할 수 있다", () => {
    const html = renderToStaticMarkup(<App />);
    const chat = /class="chat-scroll" role="region" aria-label="샘플 대화와 작업 제안" tabindex="0"/;
    const file = /class="file-content" role="region" aria-label="현재 가상 파일 내용" tabindex="0"/;
    expect(html).toMatch(chat);
    expect(html).toMatch(file);
    // 실제 발견된 결함을 다시 주입하면 같은 단언이 검출해야 한다.
    const inaccessible = html.replaceAll('tabindex="0"', 'tabindex="-1"');
    expect(inaccessible).not.toMatch(chat);
    expect(inaccessible).not.toMatch(file);
  });

  it("선택 그룹은 의미 있는 역할을 갖고 장식 점은 이름을 요구하지 않는다", () => {
    const html = renderToStaticMarkup(<App />);
    const group = /class="file-tabs" role="group" aria-label="샘플 파일 선택"/;
    expect(html).toMatch(group);
    expect(html.replace('role="group"', '')).not.toMatch(group);
    expect(html).toContain('class="project-dot" aria-hidden="true"');
    expect(html).not.toContain('class="project-dot" aria-label=');
  });
});
