import { z } from "zod";

/**
 * 플러그인 manifest 스키마.
 * permissions는 폐쇄형 열거 + 파라미터화(net.fetch:<host>) — 와일드카드 없음.
 * "무엇이든 할 수 있는 권한"이 존재하는 순간 권한 모델 전체가 장식이 된다.
 */

export const PERMISSION_PATTERN = /^(tools\.register|storage\.kv|fs\.read|fs\.write|net\.fetch:[a-z0-9.-]+|events\.subscribe:[a-z0-9.*_-]+)$/;

export const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]{2,64}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  displayName: z.string().max(100),
  description: z.string().max(500).default(""),
  entry: z.string().regex(/^[\w./-]+\.js$/),
  engines: z.object({ aios: z.string() }),
  permissions: z.array(z.string().regex(PERMISSION_PATTERN)).max(16).default([]),
  contributes: z
    .object({
      tools: z
        .array(z.object({ name: z.string().regex(/^[a-z0-9_]{1,48}$/), description: z.string().max(300) }))
        .default([]),
    })
    .default({ tools: [] }),
});

export type PluginManifest = z.infer<typeof ManifestSchema>;

export function parseManifest(json: unknown): PluginManifest {
  return ManifestSchema.parse(json);
}

/** net.fetch 권한에서 허용 호스트 추출 */
export function allowedHosts(manifest: PluginManifest, granted: string[]): Set<string> {
  const effective = manifest.permissions.filter((p) => granted.includes(p));
  return new Set(effective.filter((p) => p.startsWith("net.fetch:")).map((p) => p.slice("net.fetch:".length)));
}
