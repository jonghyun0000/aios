import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// 데모의 ‘AI·서버·파일 접근 없음’ 경계를 빌드/배포 때도 확인한다.
export function validateDemoPolicy(config) {
  if (config.outputDirectory !== "apps/demo/dist" || config.buildCommand !== "pnpm build:demo") throw new Error("공개 출력은 데모 빌드로 제한해야 합니다.");
  if (config.functions || config.rewrites?.length || config.redirects?.length) throw new Error("데모에 서버 함수나 우회 경로를 추가할 수 없습니다.");
  const headers = new Map(config.headers?.find(rule => rule.source === "/(.*)")?.headers?.map(item => [item.key.toLowerCase(), item.value]) ?? []);
  const csp = new Map((headers.get("content-security-policy") ?? "").split(";").map(part => part.trim().split(/\s+/)).filter(parts => parts[0]).map(([name, ...values]) => [name, values.join(" ")]));
  for (const name of ["default-src", "connect-src", "object-src", "base-uri", "form-action", "frame-ancestors"]) {
    if (csp.get(name) !== "'none'") throw new Error(`필수 차단 정책 누락: ${name}`);
  }
  for (const name of ["script-src", "style-src", "font-src"]) if (csp.get(name) !== "'self'") throw new Error(`외부/인라인 실행 정책: ${name}`);
  if (headers.get("x-content-type-options") !== "nosniff" || headers.get("x-frame-options") !== "DENY") throw new Error("기본 보안 헤더 누락");
  if (headers.get("referrer-policy") !== "no-referrer") throw new Error("리퍼러 보호 누락");
  return Object.fromEntries(headers);
}

export async function auditDemoBuild(root) {
  const config = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
  validateDemoPolicy(config);
  const directory = resolve(root, config.outputDirectory);
  const files = [];
  async function walk(current, prefix = "") {
    for (const item of await readdir(current, { withFileTypes: true })) {
      if (item.name.startsWith("._") || item.name === ".DS_Store") continue;
      const path = join(current, item.name); const relative = prefix + item.name;
      if ((await lstat(path)).isSymbolicLink()) throw new Error("배포물에 심볼릭 링크가 있습니다.");
      if (item.isDirectory()) { await walk(path, relative + "/"); continue; }
      if (!item.isFile() || !/\.(?:html|css|js|svg|png|ico|webp|woff2)$/.test(item.name)) throw new Error(`예상하지 않은 공개 파일: ${relative}`);
      const bytes = await readFile(path);
      files.push({ path: relative, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: createHash("sha256").update(bytes).digest("hex") });
      if (/\.(?:html|css|js|svg)$/.test(item.name)) {
        const body = bytes.toString("utf8");
        if (/localhost|127\.0\.0\.1|\/Volumes\/T7|\/Users\/|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(body)) throw new Error(`로컬 연결/비밀 형태가 배포물에 있습니다: ${relative}`);
      }
    }
  }
  await walk(directory);
  if (!files.some(file => file.path === "index.html")) throw new Error("index.html 누락");
  const javascriptGzipBytes = files.filter(file => file.path.endsWith(".js")).reduce((sum, file) => sum + file.gzipBytes, 0);
  if (javascriptGzipBytes > 160 * 1024) throw new Error("초기 데모 JavaScript 예산(160 KiB gzip) 초과");
  return { status: "passed", files, javascriptGzipBytes, scope: "정적 데모 경계 검사; 실제 AI 기능의 검증은 아님" };
}
