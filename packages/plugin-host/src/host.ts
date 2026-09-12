import { Worker } from "node:worker_threads";
import { createHash, verify as edVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AiosError } from "@aios/shared";
import type { ToolRegistry } from "@aios/tools";
import { allowedHosts, type PluginManifest } from "./manifest.js";

/**
 * Plugin Host — worker_thread 격리 + capability bridge.
 *
 * 보안 모델:
 *  1) 번들 무결성: sha256 일치 + (서명이 있으면) 개발자 ed25519 공개키 검증.
 *  2) 격리: 플러그인 코드는 워커에서 실행. 호스트 상태에 직접 접근 불가.
 *  3) capability: 워커는 postMessage RPC로만 바깥세상과 통신하고,
 *     호스트는 'granted' 권한에 해당하는 요청만 대행한다 (fetch도 호스트가 대행 —
 *     호스트 화이트리스트 검사를 워커가 우회할 수 없다).
 */

interface RpcRequest {
  id: number;
  method: "tool.result" | "fetch" | "kv.get" | "kv.set" | "tools.register";
  params: Record<string, unknown>;
}

const FetchParams = z.object({ url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"), body: z.string().optional() });
const RegisterParams = z.object({ name: z.string(), description: z.string() });

export interface LoadedPlugin {
  manifest: PluginManifest;
  stop(): Promise<void>;
}

export interface PluginHostOptions {
  registry: ToolRegistry;
  granted: string[];
  /** 마켓플레이스가 검증한 개발자 공개키 (PEM). 없으면 서명 검증 생략(로컬 개발 모드) */
  developerPublicKey?: string;
  kv: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };
}

export async function loadPlugin(
  bundlePath: string,
  manifest: PluginManifest,
  expectedSha256: string,
  signature: string | null,
  opts: PluginHostOptions,
): Promise<LoadedPlugin> {
  // --- 1) 무결성 검증 ---
  const bundle = await readFile(bundlePath);
  const sha = createHash("sha256").update(bundle).digest("hex");
  if (sha !== expectedSha256) {
    throw new AiosError("plugin_integrity", `bundle sha mismatch for ${manifest.name}`, { status: 400 });
  }
  if (signature && opts.developerPublicKey) {
    const ok = edVerify(null, Buffer.from(sha), opts.developerPublicKey, Buffer.from(signature, "base64"));
    if (!ok) throw new AiosError("plugin_signature", `bad signature for ${manifest.name}`, { status: 400 });
  }

  // --- 2) 워커 기동 ---
  const worker = new Worker(bundlePath, {
    workerData: { pluginName: manifest.name },
    // 플러그인에 환경변수를 노출하지 않는다 — 호스트의 시크릿은 호스트의 것
    env: {},
  });

  const hosts = allowedHosts(manifest, opts.granted);
  const has = (perm: string) => opts.granted.includes(perm) && manifest.permissions.includes(perm);
  const registeredTools: string[] = [];

  // 도구 호출 대기 테이블: registry handler → 워커 RPC → 결과 회신
  let callSeq = 0;
  const pendingCalls = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();

  worker.on("message", (msg: RpcRequest) => {
    void (async () => {
      try {
        switch (msg.method) {
          case "tools.register": {
            if (!has("tools.register")) throw new Error("permission tools.register not granted");
            const p = RegisterParams.parse(msg.params);
            const toolName = `plugin__${manifest.name}__${p.name}`;
            opts.registry.register({
              name: toolName,
              description: p.description,
              permission: "net", // 플러그인 도구는 기본 confirm 정책의 보호를 받는다
              schema: z.record(z.unknown()),
              handler: (_ctx, args) =>
                new Promise<string>((resolve, reject) => {
                  const id = ++callSeq;
                  pendingCalls.set(id, { resolve, reject });
                  worker.postMessage({ id, method: "tool.invoke", params: { name: p.name, args } });
                  setTimeout(() => {
                    if (pendingCalls.delete(id)) reject(new Error("plugin tool timeout"));
                  }, 30_000);
                }),
            });
            registeredTools.push(toolName);
            worker.postMessage({ id: msg.id, result: { ok: true } });
            break;
          }
          case "tool.result": {
            const { id, output, error } = msg.params as { id: number; output?: string; error?: string };
            const pending = pendingCalls.get(id);
            if (pending) {
              pendingCalls.delete(id);
              if (error) pending.reject(new Error(error));
              else pending.resolve(output ?? "");
            }
            break;
          }
          case "fetch": {
            const p = FetchParams.parse(msg.params);
            const host = new URL(p.url).hostname;
            if (!hosts.has(host)) throw new Error(`host '${host}' not in granted net.fetch permissions`);
            const res = await fetch(p.url, { method: p.method, body: p.body ?? null });
            worker.postMessage({ id: msg.id, result: { status: res.status, body: (await res.text()).slice(0, 256_000) } });
            break;
          }
          case "kv.get": {
            if (!has("storage.kv")) throw new Error("permission storage.kv not granted");
            const key = `plugin:${manifest.name}:${String(msg.params.key)}`;
            worker.postMessage({ id: msg.id, result: { value: await opts.kv.get(key) } });
            break;
          }
          case "kv.set": {
            if (!has("storage.kv")) throw new Error("permission storage.kv not granted");
            const key = `plugin:${manifest.name}:${String(msg.params.key)}`;
            await opts.kv.set(key, String(msg.params.value));
            worker.postMessage({ id: msg.id, result: { ok: true } });
            break;
          }
        }
      } catch (err) {
        worker.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  worker.on("error", (err) => {
    // 플러그인 크래시는 호스트를 죽이지 않는다 — 도구만 회수
    console.error(`plugin '${manifest.name}' crashed:`, err.message);
    for (const t of registeredTools) opts.registry.unregister(t);
  });

  return {
    manifest,
    async stop() {
      for (const t of registeredTools) opts.registry.unregister(t);
      await worker.terminate();
    },
  };
}
