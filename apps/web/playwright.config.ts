import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * 브라우저 자동 회귀 설정.
 *
 * 왜 필요한가: 여기까지 UI 검증은 전부 사람이 클릭하고 스크린샷을 본 것이었다.
 * 그러면 다음 변경에서 깨져도 **아무도 모른다.** 실제로 고친 버그들
 * (차트 라벨 겹침, 모바일 사이드바, 포커스 표시)이 다시 깨져도 알 방법이 없었다.
 *
 * 서버를 여기서 띄우지 않는 이유: 이 앱은 API가 정적 파일을 서빙하고
 * DuckDB·Postgres·Redis가 모두 필요하다. 그 조립은 scripts/verify-all.mjs 의 몫이고,
 * 여기서 중복으로 관리하면 두 곳이 서로 다르게 썩는다.
 * AIOS_BASE_URL 로 이미 떠 있는 서버를 가리킨다.
 */
const BASE = process.env.AIOS_BASE_URL ?? "http://127.0.0.1:8790";

export default defineConfig({
  testDir: "./e2e",
  // macOS 가 exFAT/SMB 볼륨에 남기는 AppleDouble 사이드카(._foo.spec.ts)를 배제한다.
  // 테스트 파일로 수집되어 "Unexpected character" 로 전체 실행이 죽는다.
  // 파일을 지워도 접근할 때마다 재생성되므로 패턴으로 막는 것이 유일한 해법이다.
  // (이 저장소에서 마이그레이션·vitest·eslint·parquet 글로브에 이어 다섯 번째다.)
  testIgnore: ["**/._*"],
  /*
   * 실패 산출물(스크린샷·trace)을 **APFS 경로**에 둔다.
   *
   * Playwright 는 실행마다 이 디렉터리를 지우고 다시 만든다. exFAT 에서는
   * macOS 가 AppleDouble 사이드카를 계속 만들어 rmdir 이 ENOTEMPTY 로 실패하고,
   * 그러면 **테스트 내용과 무관하게 전 케이스가 실패**한다.
   * 실제로 모바일 17개가 전부 그렇게 죽었고, 원인이 코드에 있는 것처럼 보여 헤맸다.
   *
   * 저장소도 외장 T7 도 둘 다 exFAT 이라 '디스크를 옮기는' 것으로는 해결되지 않는다.
   * 문제는 용량이 아니라 파일시스템이다. 산출물은 실패 진단용 임시 파일이라
   * 시스템 임시 디렉터리(APFS)가 적절하다.
   */
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? join(tmpdir(), "aios-playwright-results"),
  // 브라우저 바이너리는 T7에 있다. Mac 내장 디스크는 여유가 없다.
  // (PLAYWRIGHT_BROWSERS_PATH 환경변수로도 주지만 기본값을 명시해 둔다.)
  fullyParallel: false,       // 같은 서버·DB를 공유하므로 순차 실행이 안전하다
  forbidOnly: !!process.env.CI,
  retries: 0,                 // 재시도로 불안정을 감추면 진짜 회귀를 놓친다
  workers: 1,
  reporter: process.env.CI ? [["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE,
    // 실패했을 때 원인을 알 수 있어야 한다. 성공한 실행에는 남기지 않는다.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "ko-KR",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    {
      // iPhone 13 프리셋은 **WebKit**을 요구한다. 우리가 검증하려는 것은
      // 브라우저 엔진 차이가 아니라 반응형 레이아웃이므로, Chromium 에
      // 모바일 뷰포트만 씌운다. WebKit 까지 받으면 설치가 2배가 되고
      // CI 시간도 그만큼 늘어난다 — 얻는 것에 비해 비싸다.
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
  ],
});
