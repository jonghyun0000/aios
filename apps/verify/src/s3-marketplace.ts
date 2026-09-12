/**
 * Sprint #3 Phase B — 마켓플레이스 레지스트리 실검증.
 *
 * 이전 상태: plugins 테이블만 있고 게시/설치 엔드포인트가 없었다.
 * 여기서는 실제 HTTP로 게시 → 검색 → 설치 → 평점 → 제거 전 과정을 돌리고,
 * 보안 경계(슬러그 탈취, 미승인 버전 설치, 권한 초과 요청, 버전 불변성)를 공격해 본다.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import pg from "pg";
import { Report } from "./report.js";

const BASE = process.env.AIOS_BASE_URL ?? "http://127.0.0.1:8787";
const KEY = process.env.AIOS_API_KEY!;
const DATABASE_URL = process.env.DATABASE_URL!;

interface ApiResult<T = unknown> { status: number; body: T }

async function api<T = unknown>(
  method: string, path: string, body?: unknown, key = KEY,
): Promise<ApiResult<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed as T };
}

const report = new Report("Sprint#3 Phase B — 마켓플레이스 레지스트리");
const suffix = Date.now().toString(36);
const slug = `verify-plugin-${suffix}`;

/** 번들 바이트를 흉내 낸다. 실제 게시자는 tarball의 해시를 보낸다. */
const bundleBytes = Buffer.from(`console.log("plugin ${slug}");`);
const bundleSha = createHash("sha256").update(bundleBytes).digest("hex");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signature = cryptoSign(null, Buffer.from(bundleSha, "hex"), privateKey).toString("base64");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const manifest = (version: string) => ({
  name: slug,
  version,
  displayName: `Verify Plugin ${suffix}`,
  description: "sprint3 marketplace verification fixture",
  entry: "index.js",
  engines: { aios: "^0.1.0" },
  permissions: ["tools.register", "storage.kv"],
  contributes: { tools: [{ name: "verify_tool", description: "does nothing" }] },
});

report.section("B.1 게시");

await report.guard("서명된 번들 게시 → 자동 승인", async () => {
  const r = await api<{ status: string; version: string }>("POST", "/v1/marketplace/plugins", {
    manifest: manifest("1.0.0"),
    bundleUrl: "https://cdn.example.test/bundle-1.0.0.tgz",
    bundleSha256: bundleSha,
    signature,
    publicKey: publicKeyPem,
    keywords: ["verify", "sprint3"],
  });
  report.check("201 Created", r.status === 201, `status=${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
  report.check("서명된 버전은 approved", r.body?.status === "approved", `status=${r.body?.status}`);
});

await report.guard("잘못된 서명은 거부된다", async () => {
  const badSig = cryptoSign(null, Buffer.from("00".repeat(32), "hex"), privateKey).toString("base64");
  const r = await api("POST", "/v1/marketplace/plugins", {
    manifest: manifest("1.0.1"),
    bundleUrl: "https://cdn.example.test/evil.tgz",
    bundleSha256: bundleSha,
    signature: badSig,
    publicKey: publicKeyPem,
  });
  report.check("서명 불일치 거부", r.status === 400, `status=${r.status}`);
});

await report.guard("무서명 게시는 pending", async () => {
  const r = await api<{ status: string }>("POST", "/v1/marketplace/plugins", {
    manifest: manifest("1.1.0"),
    bundleUrl: "https://cdn.example.test/bundle-1.1.0.tgz",
    bundleSha256: bundleSha,
  });
  report.check("201 + pending", r.status === 201 && r.body?.status === "pending",
    `status=${r.status} state=${r.body?.status}`);
});

await report.guard("같은 버전 재게시는 거부된다 (불변성)", async () => {
  const r = await api<{ error?: { message?: string } }>("POST", "/v1/marketplace/plugins", {
    manifest: manifest("1.0.0"),
    bundleUrl: "https://cdn.example.test/tampered.tgz",
    bundleSha256: bundleSha,
    signature,
    publicKey: publicKeyPem,
  });
  report.check("중복 버전 거부", r.status === 400,
    `status=${r.status} msg=${r.body?.error?.message ?? ""}`);
});

report.section("B.2 검색");

await report.guard("전문 검색으로 찾을 수 있다", async () => {
  const r = await api<{ plugins: { slug: string; latest_version: string }[] }>(
    "GET", `/v1/marketplace/plugins?q=${suffix}`,
  );
  const found = r.body?.plugins?.find((p) => p.slug === slug);
  report.check("검색 결과에 포함", !!found, `hits=${r.body?.plugins?.length ?? 0}`);
  // 1.1.0은 pending이므로 latest_version(approved만)은 1.0.0이어야 한다.
  report.check("latest_version은 승인된 버전만", found?.latest_version === "1.0.0",
    `latest=${found?.latest_version}`);
});

await report.guard("상세 조회에서 pending 버전은 소유자에게만 보인다", async () => {
  const r = await api<{ versions: { version: string; status: string }[] }>(
    "GET", `/v1/marketplace/plugins/${slug}`,
  );
  const versions = r.body?.versions ?? [];
  report.check("소유 조직은 pending도 본다", versions.some((v) => v.status === "pending"),
    `versions=${versions.map((v) => `${v.version}:${v.status}`).join(",")}`);
});

report.section("B.3 설치");

await report.guard("승인된 버전 설치", async () => {
  const r = await api<{ installed: boolean; version: string }>(
    "POST", `/v1/marketplace/plugins/${slug}/install`, { grantedPermissions: ["storage.kv"] },
  );
  report.check("설치 성공", r.status === 200 && r.body?.installed === true, `status=${r.status}`);
  report.check("승인된 최신 버전 선택", r.body?.version === "1.0.0", `version=${r.body?.version}`);
});

await report.guard("소유자는 pending 버전을 '명시적으로' 설치할 수 있다", async () => {
  const r = await api<{ version: string }>(
    "POST", `/v1/marketplace/plugins/${slug}/install`,
    { version: "1.1.0", grantedPermissions: [] },
  );
  report.check("명시 설치 성공", r.status === 200 && r.body?.version === "1.1.0",
    `status=${r.status} version=${r.body?.version}`);
  // 검증 뒤 상태를 되돌린다 — 이후 검사가 설치된 버전에 의존하지 않도록
  await api("POST", `/v1/marketplace/plugins/${slug}/install`, { grantedPermissions: ["storage.kv"] });
});

await report.guard("manifest에 없는 권한 요청은 거부된다", async () => {
  const r = await api<{ error?: { message?: string } }>(
    "POST", `/v1/marketplace/plugins/${slug}/install`,
    { grantedPermissions: ["fs.write", "net.fetch:evil.test"] },
  );
  report.check("권한 초과 거부", r.status === 400,
    `status=${r.status} msg=${r.body?.error?.message ?? ""}`);
});

await report.guard("존재하지 않는 플러그인 설치는 404", async () => {
  const r = await api("POST", `/v1/marketplace/plugins/no-such-plugin-xyz/install`, {});
  report.check("404", r.status === 404, `status=${r.status}`);
});

await report.guard("설치 목록에 나타난다", async () => {
  const r = await api<{ installed: { slug: string; granted_permissions: string[] }[] }>(
    "GET", "/v1/marketplace/installed",
  );
  const entry = r.body?.installed?.find((i) => i.slug === slug);
  report.check("목록 포함", !!entry, `count=${r.body?.installed?.length ?? 0}`);
  report.check("부여 권한 정확", JSON.stringify(entry?.granted_permissions) === JSON.stringify(["storage.kv"]),
    JSON.stringify(entry?.granted_permissions));
});

await report.guard("다운로드 카운트가 증가한다", async () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ downloads: string }>(
      "select downloads from plugins where slug = $1", [slug],
    );
    report.check("downloads >= 1", Number(rows[0]?.downloads ?? 0) >= 1, `downloads=${rows[0]?.downloads}`);
  } finally { await client.end(); }
});

report.section("B.4 무결성 검증");

await report.guard("올바른 해시는 통과", async () => {
  const r = await api("POST", `/v1/marketplace/plugins/${slug}/verify`, { version: "1.0.0", sha256: bundleSha });
  report.check("verified", r.status === 200, `status=${r.status}`);
});

await report.guard("변조된 해시는 409로 거부", async () => {
  const r = await api("POST", `/v1/marketplace/plugins/${slug}/verify`,
    { version: "1.0.0", sha256: "ab".repeat(32) });
  report.check("무결성 위반 거부", r.status === 409, `status=${r.status}`);
});

report.section("B.5 슬러그 소유권");

await report.guard("다른 조직은 같은 슬러그를 탈취할 수 없다", async () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  let otherKey = "";
  try {
    const { rows: org } = await client.query<{ id: string }>(
      "insert into organizations (name, slug) values ($1,$2) returning id",
      [`attacker-${suffix}`, `attacker-${suffix}`],
    );
    const raw = `aios_live_attacker_${suffix}`;
    const hash = createHash("sha256").update(raw).digest("hex");
    await client.query(
      `insert into api_keys (org_id, name, key_hash, key_prefix, scopes, role)
       values ($1,'attacker',$2,$3,'{*}','owner')`,
      [org[0]!.id, hash, raw.slice(0, 14)],
    );
    otherKey = raw;
  } finally { await client.end(); }

  const r = await api<{ error?: { message?: string } }>(
    "POST", "/v1/marketplace/plugins",
    {
      manifest: manifest("9.9.9"),
      bundleUrl: "https://cdn.evil.test/backdoor.tgz",
      bundleSha256: bundleSha,
      signature, publicKey: publicKeyPem,
    },
    otherKey,
  );
  report.check("슬러그 탈취 차단 (403)", r.status === 403,
    `status=${r.status} msg=${r.body?.error?.message ?? ""}`);
});

report.section("B.6 평점");

await report.guard("API 키 인증(사용자 없음)은 평점을 남길 수 없다", async () => {
  const r = await api("PUT", `/v1/marketplace/plugins/${slug}/rating`, { rating: 5 });
  report.check("사용자 신원 요구 (403)", r.status === 403, `status=${r.status}`);
});

report.section("B.7 제거");

await report.guard("제거 후 목록에서 사라진다", async () => {
  const del = await api("DELETE", `/v1/marketplace/plugins/${slug}/install`);
  report.check("제거 성공", del.status === 200, `status=${del.status}`);
  const list = await api<{ installed: { slug: string }[] }>("GET", "/v1/marketplace/installed");
  report.check("목록에서 제거됨", !list.body?.installed?.some((i) => i.slug === slug), "");
  const again = await api("DELETE", `/v1/marketplace/plugins/${slug}/install`);
  report.check("중복 제거는 404", again.status === 404, `status=${again.status}`);
});

report.finish();
