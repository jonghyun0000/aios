#!/usr/bin/env node
/**
 * Node 앱(api/worker/cli) 번들러.
 *
 * 왜 tsc가 아니라 esbuild 번들인가:
 *  - pnpm 워크스페이스에서 `@aios/*` 는 소스(.ts)를 main으로 가리킨다. tsc로 각 패키지를
 *    따로 컴파일해 dist를 만들면 런타임에 심볼릭 링크·경로 재작성 문제가 줄줄이 생긴다.
 *  - 번들은 워크스페이스 패키지를 빌드 타임에 흡수하므로 컨테이너에 우리 소스가 필요 없다.
 *  - npm 의존성은 external로 남긴다(네이티브 바인딩·동적 require 때문). 이미지에는
 *    프로덕션 node_modules만 설치하면 된다.
 *
 * 산출물은 ESM(.mjs 아님, package.json type=module 기준 .js)로 낸다 —
 * 소스가 ESM이고 top-level await을 쓰기 때문.
 */
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = process.cwd();
const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));

const entries = process.argv.slice(2);
if (entries.length === 0) {
  console.error("usage: build-node-app.mjs <entry.ts> [entry2.ts ...]");
  process.exit(1);
}

/**
 * 워크스페이스 패키지(@aios/*)는 번들에 흡수하고, 실제 npm 의존성만 external로 남긴다.
 *
 * 워크스페이스 패키지의 의존성까지 external로 올리면 안 된다. pnpm의 엄격한
 * node_modules 배치 때문에 앱 디렉터리에서 해결되지 않아 런타임에
 * "Cannot find package 'ignore'" 로 죽는다 — 실제로 그렇게 만들었다가 겪었다.
 *
 * 단, 네이티브 바인딩(.node)은 esbuild가 번들할 수 없다. 그런 패키지는 앱의
 * package.json에 직접 선언해 external이 되게 하고, pnpm deploy 가 런타임 트리에 넣게 한다.
 * (@duckdb/node-api 가 그 경우다.)
 */
const external = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
  .filter((d) => !d.startsWith("@aios/"));

const result = await build({
  entryPoints: entries,
  outdir: join(pkgDir, "dist"),
  platform: "node",
  target: "node20",
  format: "esm",
  bundle: true,
  sourcemap: true,
  minify: false, // 프로덕션 스택 트레이스 가독성 > 수십 KB 절약
  external,
  logLevel: "info",
  // ESM 번들에서 CJS 의존성이 기대하는 전역을 복원한다 (pg 등 일부가 __dirname을 참조)
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_fn } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_fn(__filename);",
    ].join("\n"),
  },
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith(".js"));
for (const [file, meta] of outputs) {
  console.log(`  ${file.replace(repoRoot + "/", "")}  ${(meta.bytes / 1024).toFixed(1)} KB`);
}
