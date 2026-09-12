import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDemoPolicy } from "./public-demo-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" };

/** Vercel 보안 헤더를 로컬에서도 적용한다. API/프록시/디렉터리 목록은 제공하지 않는다. */
export async function serveDemo({ root = ROOT, port = 4174 } = {}) {
  const config = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
  const headers = validateDemoPolicy(config);
  const directory = await realpath(join(root, "apps/demo/dist"));
  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.setHeader("Cache-Control", "no-store");
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local.invalid").pathname);
      if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(part => part.startsWith("."))) { response.writeHead(404); response.end(); return; }
      const candidate = resolve(directory, pathname === "/" ? "index.html" : "." + pathname);
      const file = await realpath(candidate);
      const within = relative(directory, file);
      if (within.startsWith(".." + sep) || within === ".." || !MIME[extname(file)] || !(await stat(file)).isFile()) { response.writeHead(404); response.end(); return; }
      const bytes = await readFile(file);
      response.writeHead(200, { "Content-Type": MIME[extname(file)], "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    })().catch(() => { if (!response.headersSent) response.writeHead(404); response.end(); });
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AIOS_DEMO_PORT ?? 4174);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("AIOS_DEMO_PORT는 1024~65535 정수여야 합니다.");
  const server = await serveDemo({ port });
  console.log(`AIOS 공개 데모: http://127.0.0.1:${port} (정적 시뮬레이션·CSP 적용)`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}
