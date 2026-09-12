import { createHash, timingSafeEqual, verify as verifySignature, createPublicKey } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ForbiddenError, NotFoundError, ValidationError, AiosError } from "@aios/shared";
import { ManifestSchema } from "@aios/plugin-host";
import type { AppContext } from "../context.js";
import { requireRole } from "../auth.js";

/**
 * 마켓플레이스 레지스트리 API.
 *
 * 기존 상태: plugins/plugin_versions/plugin_installs 테이블은 있었지만 이를 조작하는
 * 서버 엔드포인트가 전혀 없었다. 즉 "마켓플레이스"라 부르면서 실제로는 로컬 디렉터리에서
 * 플러그인을 읽는 것뿐이었다. 여기서 게시(publish)·검색(search)·설치(install)를 실제로 만든다.
 *
 * 신뢰 모델 — 왜 이렇게 설계했는가:
 *  1) 번들은 sha256으로 봉인한다. 게시자가 준 해시와 실제 다운로드 바이트가 다르면 거부.
 *     이것 없이는 CDN이 뚫리는 순간 모든 설치자가 감염된다.
 *  2) 서명(ed25519)은 선택이지만, 서명이 있으면 반드시 검증한다.
 *     "있으면 검증, 없으면 통과"가 아니라 "있는데 틀리면 즉시 거부"여야 의미가 있다.
 *  3) 설치 시 권한은 manifest가 요구한 것의 부분집합만 부여할 수 있다.
 *     설치자가 manifest에 없는 권한을 줄 수는 없고(무의미), 요구된 것보다 적게 줄 수는 있다.
 *  4) 승인(approved)되지 않은 버전은 설치할 수 없다. 자기 조직이 만든 플러그인은 예외 —
 *     심사 대기 중에도 개발자가 자기 것을 테스트할 수 있어야 한다.
 */

const SlugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{2,64}$/) });

const PublishBody = z.object({
  manifest: ManifestSchema,
  bundleUrl: z.string().url(),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** base64 ed25519 서명 (sha256 다이제스트에 대한). 선택. */
  signature: z.string().base64().optional(),
  /** 서명 검증용 공개키 (PEM SPKI). signature가 있으면 필수. */
  publicKey: z.string().optional(),
  visibility: z.enum(["public", "private", "unlisted"]).default("public"),
  keywords: z.array(z.string().max(32)).max(10).default([]),
  homepage: z.string().url().optional(),
});

const InstallBody = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  grantedPermissions: z.array(z.string()).max(16).default([]),
});

// 버전 정렬은 SQL에서 `string_to_array(version,'.')::int[] desc` 로 한다.
// 문자열 정렬로는 "0.10.0" < "0.9.0" 이 되어 최신 버전을 잘못 고른다.
// 애플리케이션이 아니라 DB에서 정렬하는 이유: limit 1로 최신 버전만 가져오려면
// 정렬이 쿼리 안에 있어야 전체 버전을 앱으로 끌어오지 않는다.

function verifyEd25519(digestHex: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verifySignature(
      null, // ed25519는 사전 해시 알고리즘을 지정하지 않는다
      Buffer.from(digestHex, "hex"),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export function registerMarketplaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------- 검색 ----------
  app.get("/v1/marketplace/plugins", async (req) => {
    const q = z
      .object({
        q: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
        sort: z.enum(["downloads", "recent", "relevance"]).default("downloads"),
      })
      .parse(req.query ?? {});

    // 가시성 규칙: public + unlisted(직접 링크로만 노출되므로 검색에서는 제외) + 내 조직의 private
    // unlisted를 검색 결과에서 빼는 것이 'unlisted'의 정의다.
    const params: unknown[] = [req.auth.orgId, q.limit, q.offset];
    let where = `(p.visibility = 'public' or p.author_org = $1)`;
    let orderBy = "p.downloads desc, p.created_at desc";

    if (q.q) {
      params.push(q.q);
      const i = params.length;
      where += ` and p.tsv @@ plainto_tsquery('simple', $${i})`;
      if (q.sort === "relevance") orderBy = `ts_rank(p.tsv, plainto_tsquery('simple', $${i})) desc`;
    }
    if (q.sort === "recent") orderBy = "p.updated_at desc";

    const { rows } = await ctx.pool.query(
      `select p.id, p.slug, p.name, p.description, p.downloads, p.keywords, p.homepage,
              p.visibility, p.created_at, p.updated_at,
              (select version from plugin_versions v
                where v.plugin_id = p.id and v.status = 'approved'
                order by string_to_array(v.version, '.')::int[] desc limit 1) as latest_version,
              coalesce((select round(avg(rating)::numeric, 2) from plugin_ratings r where r.plugin_id = p.id), 0) as rating,
              (select count(*) from plugin_ratings r where r.plugin_id = p.id) as rating_count
         from plugins p
        where ${where}
        order by ${orderBy}
        limit $2 offset $3`,
      params,
    );
    return { plugins: rows, limit: q.limit, offset: q.offset };
  });

  // ---------- 상세 ----------
  app.get("/v1/marketplace/plugins/:slug", async (req) => {
    const { slug } = SlugParam.parse(req.params);
    const { rows } = await ctx.pool.query(
      `select p.*, (p.author_org = $2) as is_owner
         from plugins p
        where p.slug = $1 and (p.visibility in ('public','unlisted') or p.author_org = $2)`,
      [slug, req.auth.orgId],
    );
    const plugin = rows[0];
    if (!plugin) throw new NotFoundError(`plugin '${slug}' not found`);

    const { rows: versions } = await ctx.pool.query(
      `select id, version, status, bundle_url, bundle_sha256, signature is not null as signed,
              manifest, created_at
         from plugin_versions where plugin_id = $1
         order by string_to_array(version, '.')::int[] desc`,
      [plugin.id],
    );
    const { rows: ratings } = await ctx.pool.query(
      `select coalesce(round(avg(rating)::numeric,2),0) as avg, count(*)::int as count
         from plugin_ratings where plugin_id = $1`,
      [plugin.id],
    );
    // 소유자가 아니면 승인된 버전만 보여준다 — 심사 중인 버전의 번들 URL이 새면 심사가 무의미해진다.
    const visible = plugin.is_owner ? versions : versions.filter((v) => v.status === "approved");
    return { plugin: { ...plugin, tsv: undefined }, versions: visible, rating: ratings[0] };
  });

  // ---------- 게시 ----------
  app.post("/v1/marketplace/plugins", async (req, reply) => {
    requireRole(req.auth, "admin"); // 조직 이름으로 공개 게시하는 행위 — member에게는 과하다
    const body = PublishBody.parse(req.body);

    if (body.signature && !body.publicKey) {
      throw new ValidationError("signature provided without publicKey");
    }
    if (body.signature && body.publicKey) {
      if (!verifyEd25519(body.bundleSha256, body.signature, body.publicKey)) {
        // 서명이 있는데 틀리면 즉시 거부. '검증 실패 시 무서명으로 강등'은 공격자에게 우회로를 준다.
        throw new ValidationError("ed25519 signature does not verify against bundleSha256");
      }
    }

    const slug = body.manifest.name;
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");

      // upsert plugin — 이미 있으면 소유 조직 확인
      const { rows: existing } = await client.query<{ id: string; author_org: string | null }>(
        "select id, author_org from plugins where slug = $1 for update",
        [slug],
      );
      let pluginId: string;
      if (existing[0]) {
        if (existing[0].author_org !== req.auth.orgId) {
          // 슬러그 탈취 방지. 이게 없으면 아무나 인기 플러그인 이름으로 악성 버전을 올릴 수 있다.
          throw new ForbiddenError(`slug '${slug}' is owned by another organization`);
        }
        pluginId = existing[0].id;
        await client.query(
          `update plugins set name = $2, description = $3, visibility = $4,
                  keywords = $5, homepage = $6, updated_at = now()
             where id = $1`,
          [pluginId, body.manifest.displayName, body.manifest.description, body.visibility,
           body.keywords, body.homepage ?? null],
        );
      } else {
        const { rows } = await client.query<{ id: string }>(
          `insert into plugins (slug, name, description, author_org, visibility, keywords, homepage)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [slug, body.manifest.displayName, body.manifest.description, req.auth.orgId,
           body.visibility, body.keywords, body.homepage ?? null],
        );
        pluginId = rows[0]!.id;
      }

      // 버전은 불변이다. 같은 버전 재게시를 허용하면 이미 설치한 사람의 코드가 몰래 바뀐다.
      const { rows: dup } = await client.query(
        "select 1 from plugin_versions where plugin_id = $1 and version = $2",
        [pluginId, body.manifest.version],
      );
      if (dup[0]) {
        throw new ValidationError(
          `version ${body.manifest.version} already published; versions are immutable`,
        );
      }

      const { rows: ver } = await client.query<{ id: string }>(
        `insert into plugin_versions (plugin_id, version, manifest, bundle_url, bundle_sha256, signature, status)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [pluginId, body.manifest.version, JSON.stringify(body.manifest), body.bundleUrl,
         body.bundleSha256, body.signature ?? null,
         // 자동 승인 정책: 서명된 번들은 자동 승인, 무서명은 심사 대기.
         // 무서명을 자동 승인하면 심사 단계 자체가 없는 것과 같다.
         body.signature ? "approved" : "pending"],
      );

      await client.query(
        `insert into plugin_publish_events (plugin_id, version_id, actor_id, action, detail)
         values ($1,$2,$3,'publish',$4)`,
        [pluginId, ver[0]!.id, req.auth.userId ?? null,
         JSON.stringify({ version: body.manifest.version, signed: !!body.signature })],
      );

      await client.query("commit");
      reply.status(201);
      return {
        pluginId,
        versionId: ver[0]!.id,
        slug,
        version: body.manifest.version,
        status: body.signature ? "approved" : "pending",
      };
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  });

  // ---------- 심사 (플랫폼 운영자) ----------
  app.post("/v1/marketplace/plugins/:slug/versions/:version/review", async (req) => {
    requireRole(req.auth, "owner");
    if (!ctx.env.MARKETPLACE_REVIEWER_ORG || ctx.env.MARKETPLACE_REVIEWER_ORG !== req.auth.orgId) {
      // 심사는 플랫폼 운영 조직만. 이 확인이 없으면 게시자가 자기 것을 스스로 승인한다.
      throw new ForbiddenError("only the marketplace reviewer organization can review versions");
    }
    const params = z.object({ slug: z.string(), version: z.string() }).parse(req.params);
    const body = z.object({ action: z.enum(["approve", "reject", "yank"]), note: z.string().max(500).optional() })
      .parse(req.body);

    const status = body.action === "approve" ? "approved" : "rejected";
    const { rows } = await ctx.pool.query<{ id: string; plugin_id: string }>(
      `update plugin_versions v set status = $3
         from plugins p
        where v.plugin_id = p.id and p.slug = $1 and v.version = $2
        returning v.id, v.plugin_id`,
      [params.slug, params.version, status],
    );
    if (!rows[0]) throw new NotFoundError(`${params.slug}@${params.version} not found`);

    await ctx.pool.query(
      `insert into plugin_publish_events (plugin_id, version_id, actor_id, action, detail)
       values ($1,$2,$3,$4,$5)`,
      [rows[0].plugin_id, rows[0].id, req.auth.userId ?? null, body.action,
       JSON.stringify({ note: body.note ?? null })],
    );
    return { ok: true, status };
  });

  // ---------- 설치 ----------
  app.post("/v1/marketplace/plugins/:slug/install", async (req) => {
    requireRole(req.auth, "admin"); // 설치는 조직 전체에 코드를 들이는 행위
    const { slug } = SlugParam.parse(req.params);
    const body = InstallBody.parse(req.body ?? {});

    const { rows: plugins } = await ctx.pool.query<{ id: string; author_org: string | null; visibility: string }>(
      "select id, author_org, visibility from plugins where slug = $1",
      [slug],
    );
    const plugin = plugins[0];
    if (!plugin) throw new NotFoundError(`plugin '${slug}' not found`);
    if (plugin.visibility === "private" && plugin.author_org !== req.auth.orgId) {
      throw new NotFoundError(`plugin '${slug}' not found`); // 존재 여부 자체를 숨긴다
    }

    const isOwner = plugin.author_org === req.auth.orgId;
    const { rows: versions } = await ctx.pool.query<{
      id: string; version: string; status: string; manifest: { permissions?: string[] };
    }>(
      `select id, version, status, manifest from plugin_versions
        where plugin_id = $1 ${body.version ? "and version = $2" : ""}
        order by string_to_array(version, '.')::int[] desc`,
      body.version ? [plugin.id, body.version] : [plugin.id],
    );
    // 버전 선택 규칙:
    //  - 버전을 명시했으면 그것만 본다(소유자는 pending도 허용 — 자기 것을 테스트해야 하므로).
    //  - 명시하지 않았으면 언제나 '승인된 최신 버전'이다. 소유자라고 해서 심사 중인 버전이
    //    조용히 선택되면 안 된다 — 관리자가 승인된 것을 설치했다고 믿는 사이
    //    미심사 코드가 조직에 들어간다. 실제로 이 검증에서 1.1.0(pending)이 선택됐다.
    const target = body.version
      ? versions.find((v) => v.status === "approved" || isOwner)
      : versions.find((v) => v.status === "approved");
    if (!target) {
      throw new NotFoundError(
        body.version
          ? `${slug}@${body.version} is not available (status: ${versions[0]?.status ?? "missing"})`
          : `${slug} has no approved version` +
            (isOwner && versions[0] ? ` (latest is ${versions[0].version}: ${versions[0].status}; install it by naming the version explicitly)` : ""),
      );
    }

    // 권한은 manifest가 요구한 것의 부분집합만. 초과 요청은 조용히 잘라내지 않고 거부한다 —
    // 관리자가 무엇을 승인했는지 착각하면 안 된다.
    const declared = new Set(target.manifest.permissions ?? []);
    const extra = body.grantedPermissions.filter((p) => !declared.has(p));
    if (extra.length > 0) {
      throw new ValidationError(`permissions not declared in manifest: ${extra.join(", ")}`);
    }

    await ctx.pool.query(
      `insert into plugin_installs (org_id, plugin_id, version_id, granted_permissions, installed_by)
       values ($1,$2,$3,$4,$5)
       on conflict (org_id, plugin_id)
       do update set version_id = excluded.version_id,
                     granted_permissions = excluded.granted_permissions,
                     enabled = true`,
      [req.auth.orgId, plugin.id, target.id, body.grantedPermissions, req.auth.userId ?? null],
    );
    // 다운로드 카운트는 설치 시점에 올린다. 조회수가 아니라 실제 채택 지표여야 유용하다.
    await ctx.pool.query("update plugins set downloads = downloads + 1 where id = $1", [plugin.id]);

    return { installed: true, slug, version: target.version, grantedPermissions: body.grantedPermissions };
  });

  // ---------- 설치 목록 / 제거 ----------
  app.get("/v1/marketplace/installed", async (req) => {
    const { rows } = await ctx.pool.query(
      `select p.slug, p.name, v.version, i.enabled, i.granted_permissions, i.created_at
         from plugin_installs i
         join plugins p on p.id = i.plugin_id
         join plugin_versions v on v.id = i.version_id
        where i.org_id = $1
        order by i.created_at desc`,
      [req.auth.orgId],
    );
    return { installed: rows };
  });

  app.delete("/v1/marketplace/plugins/:slug/install", async (req) => {
    requireRole(req.auth, "admin");
    const { slug } = SlugParam.parse(req.params);
    const { rowCount } = await ctx.pool.query(
      `delete from plugin_installs i using plugins p
        where i.plugin_id = p.id and p.slug = $1 and i.org_id = $2`,
      [slug, req.auth.orgId],
    );
    if (rowCount === 0) throw new NotFoundError(`'${slug}' is not installed`);
    return { uninstalled: true };
  });

  // ---------- 평점 ----------
  app.put("/v1/marketplace/plugins/:slug/rating", async (req) => {
    const { slug } = SlugParam.parse(req.params);
    const body = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() })
      .parse(req.body);
    if (!req.auth.userId) throw new ForbiddenError("rating requires a user identity (not an API key)");

    const { rows } = await ctx.pool.query<{ id: string }>("select id from plugins where slug = $1", [slug]);
    if (!rows[0]) throw new NotFoundError(`plugin '${slug}' not found`);

    // 설치하지 않은 사람의 평점은 받지 않는다. 이게 없으면 경쟁 플러그인 별점 테러가 가능하다.
    const { rows: installed } = await ctx.pool.query(
      "select 1 from plugin_installs where org_id = $1 and plugin_id = $2",
      [req.auth.orgId, rows[0].id],
    );
    if (!installed[0]) throw new ForbiddenError("only organizations that installed the plugin can rate it");

    await ctx.pool.query(
      `insert into plugin_ratings (plugin_id, user_id, rating, comment) values ($1,$2,$3,$4)
       on conflict (plugin_id, user_id) do update set rating = excluded.rating, comment = excluded.comment`,
      [rows[0].id, req.auth.userId, body.rating, body.comment ?? null],
    );
    return { ok: true };
  });

  // ---------- 번들 무결성 확인 ----------
  // 설치 클라이언트(런타임/CLI)가 번들을 받은 뒤 이 엔드포인트로 해시를 재확인할 수 있다.
  app.post("/v1/marketplace/plugins/:slug/verify", async (req) => {
    const { slug } = SlugParam.parse(req.params);
    const body = z.object({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
    const { rows } = await ctx.pool.query<{ bundle_sha256: string }>(
      `select v.bundle_sha256 from plugin_versions v join plugins p on p.id = v.plugin_id
        where p.slug = $1 and v.version = $2`,
      [slug, body.version],
    );
    if (!rows[0]) throw new NotFoundError(`${slug}@${body.version} not found`);
    const a = Buffer.from(rows[0].bundle_sha256, "hex");
    const b = Buffer.from(body.sha256, "hex");
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      throw new AiosError("plugin_integrity", "bundle sha256 mismatch — refuse to load", { status: 409 });
    }
    return { verified: true };
  });
}

/** 번들 바이트의 sha256 — CLI/런타임이 게시 전 해시를 계산할 때 쓴다. */
export function bundleDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
