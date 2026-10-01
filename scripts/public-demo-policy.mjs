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

const DEPLOY_ENVIRONMENT = "demo-production";
const PUBLIC_DEMO_URL = "https://aios-demo-mu.vercel.app";

/** 최상위 jobs 아래의 잡을 이름별 텍스트로 나눈다. 정책 검사에 필요한 만큼만 해석한다. */
function splitJobs(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (start < 0) throw new Error("jobs 섹션이 없습니다.");
  const jobs = new Map();
  let current;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) { current = header[1]; jobs.set(current, []); continue; }
    if (current) jobs.get(current).push(line);
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join("\n")]));
}

/**
 * 체험판 배포 워크플로의 안전 경계.
 * 승인 게이트·최소 권한·토큰 격리가 빠지면 push 한 번이 승인 없이 공개 사이트를 바꾸거나
 * 포크 PR이 배포 토큰을 읽을 수 있게 된다. YAML 문법은 actionlint/GitHub가 검사하고,
 * 여기서는 그 문법이 맞아도 놓치는 정책만 본다.
 */
export function validateDeployWorkflow(text) {
  const header = text.slice(0, text.search(/^jobs:\s*$/m));
  if (/pull_request/.test(header)) throw new Error("PR 트리거로 배포 워크플로를 실행할 수 없습니다.");
  if (!/^ {2}workflow_dispatch:\s*$/m.test(header)) throw new Error("수동 실행(workflow_dispatch)이 필요합니다.");
  const push = header.match(/^ {2}push:[ \t]*\n((?: {4,}[^\n]*\n)+)/m);
  if (push && !/branches:\s*\[\s*main\s*\]/.test(push[1])) throw new Error("push 트리거는 main으로 제한해야 합니다.");
  if (push && !/paths:/.test(push[1])) throw new Error("push 트리거는 체험판 경로로 제한해야 합니다.");
  if (!/^permissions:\s*\n {2}contents: read\s*$/m.test(text)) throw new Error("최상위 권한은 contents: read 하나여야 합니다.");
  if (/:\s*write\b|write-all/.test(text)) throw new Error("쓰기 권한을 줄 수 없습니다.");
  if (!/cancel-in-progress:\s*false/.test(text)) throw new Error("진행 중인 배포를 취소하면 안 됩니다.");

  const jobs = splitJobs(text);
  const deploy = jobs.get("deploy");
  if (!deploy) throw new Error("deploy 잡이 없습니다.");
  if (!/^ {4}needs:\s*verify\s*$/m.test(deploy) || !jobs.has("verify")) throw new Error("deploy는 verify 잡 뒤에만 실행해야 합니다.");
  if (!new RegExp(`^ {4}environment:\\s*\\n {6}name:\\s*${DEPLOY_ENVIRONMENT}\\s*$`, "m").test(deploy)) throw new Error(`deploy는 승인 Environment ${DEPLOY_ENVIRONMENT}를 거쳐야 합니다.`);
  for (const [name, body] of jobs) if (name !== "deploy" && /\bsecrets\./.test(body)) throw new Error(`배포 비밀값은 deploy 잡에만 둘 수 있습니다: ${name}`);
  if (/\bsecrets\./.test(header)) throw new Error("배포 비밀값을 워크플로 전역에 둘 수 없습니다.");
  for (const body of jobs.values()) if (/uses:\s*[^\s@]+@(?![0-9a-f]{40}\b)/.test(body)) throw new Error("액션은 커밋 SHA로 고정해야 합니다.");
  if (!/vercel@\d+\.\d+\.\d+\b/.test(deploy) || /vercel@(?:latest|canary)/.test(deploy)) throw new Error("Vercel CLI 버전을 고정해야 합니다.");

  const order = ["vercel_cli pull", "vercel_cli build --prod", "check-vercel-output.mjs", "deploy --prebuilt --prod", "verify-public-demo.mjs"];
  const flat = deploy.replace(/"\$VERCEL_CLI"/g, "vercel_cli");
  let cursor = -1;
  for (const marker of order) {
    const at = flat.indexOf(marker, cursor + 1);
    if (at < 0) throw new Error(`배포 단계 순서가 맞지 않습니다: ${marker}`);
    cursor = at;
  }
  if (!flat.includes(`AIOS_DEMO_URL: ${PUBLIC_DEMO_URL}`)) throw new Error("배포 뒤 공개 Production 주소를 검증해야 합니다.");
  return { environment: DEPLOY_ENVIRONMENT, url: PUBLIC_DEMO_URL };
}

/**
 * `vercel build`가 만든 업로드 대상(.vercel/output/static)이 감사한 데모 빌드와 같은 파일 집합·바이트인지 확인한다.
 * 다르면 검사하지 않은 파일이 공개된다.
 */
export async function checkPrebuiltOutput(root) {
  const audit = await auditDemoBuild(root);
  const output = resolve(root, ".vercel/output");
  const config = JSON.parse(await readFile(join(output, "config.json"), "utf8"));
  if (!Array.isArray(config.routes)) throw new Error("Vercel 출력에 라우트(보안 헤더) 설정이 없습니다.");
  if (await readdir(join(output, "functions")).then(items => items.length > 0, () => false)) throw new Error("업로드 대상에 서버 함수가 있습니다.");
  const uploaded = [];
  async function walk(current, prefix = "") {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name); const relative = prefix + item.name;
      if ((await lstat(path)).isSymbolicLink()) throw new Error("업로드 대상에 심볼릭 링크가 있습니다.");
      if (item.isDirectory()) { await walk(path, relative + "/"); continue; }
      uploaded.push({ path: relative, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
    }
  }
  await walk(join(output, "static"));
  const expected = new Map(audit.files.map(file => [file.path, file.sha256]));
  for (const file of uploaded) {
    if (!expected.has(file.path)) throw new Error(`감사하지 않은 파일이 업로드 대상에 있습니다: ${file.path}`);
    if (expected.get(file.path) !== file.sha256) throw new Error(`업로드 대상이 감사한 빌드와 다릅니다: ${file.path}`);
  }
  for (const path of expected.keys()) if (!uploaded.some(file => file.path === path)) throw new Error(`업로드 대상에 빠진 파일: ${path}`);
  return { status: "passed", files: uploaded.length, javascriptGzipBytes: audit.javascriptGzipBytes };
}
