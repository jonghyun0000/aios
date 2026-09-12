// AIOS 예제 플러그인 — worker_thread 안에서 실행된다.
// 바깥세상 접근은 전부 parentPort RPC 경유: 호스트가 권한을 검사하고 대행한다.
import { parentPort } from "node:worker_threads";

let seq = 0;
const pending = new Map();

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ id, method, params });
  });
}

const handlers = {
  async gh_stars(args) {
    const repo = String(args.repo ?? "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return "usage: { repo: 'owner/name' }";
    const res = await rpc("fetch", { url: `https://api.github.com/repos/${repo}` });
    if (res.status !== 200) return `github returned ${res.status}`;
    const data = JSON.parse(res.body);
    return `${repo} has ${data.stargazers_count} stars`;
  },
};

parentPort.on("message", async (msg) => {
  // 호스트 → 워커: 도구 실행 요청
  if (msg.method === "tool.invoke") {
    const { name, args } = msg.params;
    try {
      const output = await handlers[name](args);
      parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, output } });
    } catch (err) {
      parentPort.postMessage({ id: 0, method: "tool.result", params: { id: msg.id, error: String(err) } });
    }
    return;
  }
  // 호스트 → 워커: RPC 응답
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
  }
});

// 부팅: 도구 등록
await rpc("tools.register", { name: "gh_stars", description: "Get star count for a GitHub repo. Args: { repo: 'owner/name' }" });
