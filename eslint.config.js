// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * ESLint flat config (모노레포 루트 단일 설정).
 *
 * 규칙 선정 기준: "타입체커가 못 잡고, 리뷰어가 놓치기 쉬우며, 프로덕션에서 실제로 아픈 것"만 켠다.
 * 스타일 규칙(quotes, semi, indent)은 넣지 않는다 — 포매터의 일이고, 린트 실패로 CI를 막을 가치가 없다.
 *
 * 특히 error 등급으로 올린 것들:
 *  - no-floating-promises: 비동기 에러가 조용히 사라지는 가장 흔한 경로
 *  - no-misused-promises: async 함수를 동기 콜백에 넘겨 에러가 유실되는 패턴
 *  - require-await / await-thenable: 잘못된 async 시그니처는 호출자의 에러 처리를 무력화한다
 *  - no-console: 서버 코드는 구조화 로거를 써야 관측 가능하다 (스크립트/CLI는 예외 처리)
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "plugins/**", // 플러그인 번들은 워커에서 도는 순수 JS 예제
      "eslint.config.js",
      // macOS가 exFAT/SMB 볼륨에 남기는 AppleDouble 리소스 포크.
      // 파일 접근 때마다 재생성되므로 삭제가 아니라 무시가 유일한 해법이다.
      "**/._*",
      "**/test-results/**",     // Playwright 실패 산출물
      "**/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      // require-await는 끈다. 인터페이스를 만족시키려고 async여야 하지만 await이 없는 메서드
      // (ProviderAdapter.embed 처럼 즉시 throw 하는 구현, 테스트 더블)에서 거짓 양성이 지배적이다.
      // 진짜 위험한 경우 — 비동기 에러 유실 — 는 no-floating-promises / no-misused-promises 가 잡는다.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      // 프로바이더 응답 JSON은 정의상 unknown이라 안전한 접근이 어렵다. 경계 코드에서만 허용.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "no-console": "off",
    },
  },
  {
    // 서버 런타임 코드는 구조화 로거(app.log)를 써야 한다 — console은 관측 파이프라인 밖으로 샌다.
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/main.ts", "apps/api/src/worker.ts"],
    rules: { "no-console": "error" },
  },
  {
    // 빌드/마이그레이션 스크립트와 스모크 테스트는 tsconfig 프로젝트 밖에 있다.
    // 타입 인지 규칙을 끄고 문법 검사만 적용한다 — 프로젝트에 억지로 편입시키면
    // 앱 빌드 산출물에 스크립트가 딸려 들어간다.
    // 주의: 객체 스프레드로 disableTypeChecked를 합치면 아래 rules가 그 rules를 통째로
    // 덮어써서 규칙이 살아남는다. 반드시 별도 config 항목으로 나열해야 한다.
    files: ["scripts/**/*.{mjs,js}", "packages/*/scripts/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
      globals: { ...globals.node },
    },
  },
  {
    files: ["scripts/**/*.{mjs,js}", "packages/*/scripts/**/*.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.{mjs,js}", "packages/*/scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  {
    // 웹 앱: React 훅 규칙.
    // exhaustive-deps를 켜는 이유는 스타일이 아니라 버그다 — 의존성을 빠뜨리면
    // 클로저가 낡은 상태를 붙잡아 "가끔 예전 값이 보이는" 재현 어려운 문제가 된다.
    // 다만 error가 아니라 warn으로 두면 --max-warnings=0에서 어차피 실패하므로 error로 둔다.
    files: ["apps/web/**/*.{ts,tsx}", "apps/demo/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // 테스트는 의도적으로 이상한 값을 만들어 경계를 두드린다. 프로덕션 규칙을 그대로 걸면
    // 테스트가 규칙을 피해 다니게 되고, 그 순간 테스트의 가치가 떨어진다.
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);
