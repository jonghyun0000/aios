import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "@aios/shared";
import type { AppContext } from "../context.js";

/**
 * 공공통계 조회 API (웹 UI용).
 *
 * 도구(bigdata_query)와 달리 **임의 SQL을 받지 않는다.**
 * 도구는 LLM이 쓰고 격리 4겹으로 감싸져 있지만, 브라우저에 SQL 창을 여는 것은 성격이 다르다 —
 * 조직 구성원 누구나 무거운 질의로 서버를 마비시킬 수 있고, 그것을 막을 방법이
 * 결국 또 다른 화이트리스트가 된다. 여기서는 필요한 질문 모양만 파라미터로 노출한다.
 *
 * 반환 형태가 도구(TSV)와 다른 이유: 도구는 토큰을 아껴야 하고, UI는 타입이 필요하다.
 */

/**
 * DuckDB의 BIGINT는 JS BigInt로 온다. JSON.stringify가 이것을 만나면 던진다
 * ("Do not know how to serialize a BigInt") — 실제로 처음에 그렇게 깨졌다.
 * 정밀도 손실이 없는 범위면 number로, 아니면 문자열로 낮춘다.
 */
function jsonSafe<T>(rows: T[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      out[k] = typeof v === "bigint"
        ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(v)
            : v.toString())
        : v;
    }
    return out as T;
  });
}

/**
 * 요청 수명에 묶인 AbortSignal.
 *
 * 두 가지를 함께 처리한다:
 *  - 타임아웃: 무거운 질의가 서버를 붙잡지 못하게
 *  - 클라이언트 이탈: 사용자가 페이지를 떠나면 DuckDB 작업도 즉시 멈춘다.
 *    이게 없으면 새로고침을 몇 번 하는 것만으로 질의가 쌓여 CPU를 태운다.
 *    (Fastify의 req.raw 는 IncomingMessage 라 signal 속성이 없다 — 직접 만들어야 한다.)
 */
function requestSignal(reply: { raw: { once(ev: "close", cb: () => void): void; destroyed: boolean } }, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  if (reply.raw.destroyed) { clearTimeout(timer); controller.abort(); }
  else reply.raw.once("close", () => { clearTimeout(timer); controller.abort(); });
  return controller.signal;
}

/**
 * 필터 드롭다운에 채울 최대 항목 수.
 * 실측상 한 통계표의 지역 종류는 최대 205개다. 그보다 넉넉히 잡되 무한은 아니다 —
 * 항목이 수천 개인 통계표에서 드롭다운이 브라우저를 멈추게 하면 안 된다.
 */
const FACET_LIMIT = 400;

/** 문자열 리터럴 이스케이프. 이 라우트는 사용자 SQL을 받지 않지만 값은 받는다. */
const esc = (v: string) => v.replace(/'/g, "''");

export function registerBigDataRoutes(app: FastifyInstance, ctx: AppContext): void {
  const store = ctx.bigdata;
  // 데이터셋이 없는 배포에서는 라우트를 아예 만들지 않는다.
  // 빈 배열을 돌려주면 UI가 "데이터가 없다"와 "기능이 없다"를 구분하지 못한다.
  if (!store) return;

  app.get("/v1/bigdata/categories", async (_req, reply) => {
    const rows = await store.query(
      `select category, count(*) series_count, sum(row_count) row_count
         from catalog group by 1 order by row_count desc`,
      requestSignal(reply, store.timeoutMs),
    );
    return { categories: jsonSafe(rows) };
  });

  app.get("/v1/bigdata/catalog", async (req, reply) => {
    const q = z
      .object({
        q: z.string().max(100).optional(),
        category: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).default(0),
        sort: z.enum(["rows", "name", "recent"]).default("rows"),
      })
      .parse(req.query ?? {});

    const where: string[] = [];
    if (q.q) where.push(`series_name ilike '%${esc(q.q)}%'`);
    if (q.category) where.push(`category = '${esc(q.category)}'`);
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    // 정렬 키에 동점이 흔하다(row_count가 같은 통계표가 여럿). 타이브레이커가 없으면
    // 페이지마다 순서가 달라져 1페이지와 2페이지에 같은 행이 겹쳐 나온다 — 실제로 겹쳤다.
    // series_id로 최종 정렬해 순서를 결정적으로 만든다.
    const order = (q.sort === "name" ? "series_name asc"
      : q.sort === "recent" ? "period_max desc nulls last"
      : "row_count desc") + ", series_id asc";

    const signal = requestSignal(reply, store.timeoutMs);
    // 총계를 함께 준다. 없으면 UI가 페이지네이션을 그릴 수 없다.
    const [rows, total] = await Promise.all([
      store.query(
        `select series_id, category, source, table_code, series_name, unit, period_type,
                period_min, period_max, row_count, region_count, region_code_count, item_count, null_count
           from catalog ${clause} order by ${order} limit ${q.limit} offset ${q.offset}`,
        signal,
      ),
      store.query(`select count(*) n from catalog ${clause}`, signal),
    ]);
    return {
      series: jsonSafe(rows),
      total: Number(total[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/v1/bigdata/series/:id", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z
      .object({
        period_prefix: z.string().max(20).optional(),
        region: z.string().max(60).optional(),
        item: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(400),
      })
      .parse(req.query ?? {});

    const signal = requestSignal(reply, store.timeoutMs);
    const meta = await store.query(
      `select series_id, category, source, table_code, series_name, unit, period_type,
              period_min, period_max, row_count, region_count, region_code_count, item_count, null_count, rel_path
         from catalog where series_id = ${id}`,
      signal,
    );
    if (meta.length === 0) throw new NotFoundError(`series ${id}`);

    const where = [`series_id = ${id}`];
    if (q.period_prefix) where.push(`period like '${esc(q.period_prefix)}%'`);
    if (q.region) where.push(`region = '${esc(q.region)}'`);
    if (q.item) where.push(`item = '${esc(q.item)}'`);

    // 차트용 시계열은 오름차순이 자연스럽다. 화면에서 뒤집지 않게 여기서 정렬한다.
    const [points, regions, items] = await Promise.all([
      store.query(
        `select period, count(*) n, avg(value) avg_value, min(value) min_value, max(value) max_value
           from facts where ${where.join(" and ")} and value is not null
          group by period order by period asc limit ${q.limit}`,
        signal,
      ),
      // 상한을 카탈로그의 region_count(205까지 관측됨)보다 넉넉히 잡는다.
      // 50으로 자르면 화면이 "지역 205개"라고 말하면서 50개만 고르게 해 사용자를 속인다.
      store.query(
        `select region, count(*) n from facts where series_id = ${id} and region is not null
          group by 1 order by n desc limit ${FACET_LIMIT}`,
        signal,
      ),
      store.query(
        `select item, count(*) n from facts where series_id = ${id} and item is not null
          group by 1 order by n desc limit ${FACET_LIMIT}`,
        signal,
      ),
    ]);

    // 잘렸는지 알려준다. 조용히 자르면 차트가 "2025-08 전체"인 척하면서
    // 실제로는 앞 2.8일만 보여준다 — 해양관측처럼 10분 간격 데이터에서 실제로 그랬다.
    const truncated = points.length >= q.limit;
    return {
      series: jsonSafe(meta)[0],
      points: jsonSafe(points),
      regions: jsonSafe(regions),
      items: jsonSafe(items),
      truncated,
      limit: q.limit,
    };
  });

  /**
   * CSV 내보내기. 브라우저가 파일로 저장한다.
   * JSON이 아니라 CSV인 이유: 사용자가 이 데이터를 엑셀·파이썬으로 가져가는 것이 목적이다.
   */
  app.get("/v1/bigdata/series/:id/export", async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z.object({
      period_prefix: z.string().max(20).optional(),
      region: z.string().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(100_000).default(50_000),
    }).parse(req.query ?? {});

    const signal = requestSignal(reply, store.timeoutMs);
    const where = [`f.series_id = ${id}`];
    if (q.period_prefix) where.push(`f.period like '${esc(q.period_prefix)}%'`);
    if (q.region) where.push(`f.region = '${esc(q.region)}'`);

    const rows = await store.query(
      `select f.period, f.region, f.region_code, f.sido, f.cls1, f.cls2, f.cls3,
              f.item, f.value, f.raw_value
         from facts f where ${where.join(" and ")}
        order by f.period asc limit ${q.limit}`,
      signal,
    );
    const cols = ["period", "region", "region_code", "sido", "cls1", "cls2", "cls3", "item", "value", "raw_value"];
    const escapeCsv = (v: unknown) => {
      if (v === null || v === undefined) return "";
      // 스칼라만 문자열로 만든다. 객체가 새어 들어오면 "[object Object]"가 CSV에 박히고
      // 사용자는 그것을 데이터로 읽는다. 예상 밖 타입은 JSON으로 남겨 추적 가능하게 둔다.
      const s =
        typeof v === "string" ? v
        : typeof v === "bigint" || typeof v === "number" || typeof v === "boolean" ? v.toString()
        : JSON.stringify(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      cols.join(","),
      ...rows.map((r) => cols.map((c) => escapeCsv(r[c])).join(",")),
    ].join("\n");

    // UTF-8 BOM을 붙인다. 없으면 Excel(Windows)이 한글을 깨뜨린다.
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="series-${id}.csv"`)
      // BOM은 리터럴이 아니라 이스케이프로 쓴다 — 소스에 보이지 않는 문자를 남기면
      // 다음 사람이 편집하다 지우고도 모르고, lint(no-irregular-whitespace)에도 걸린다.
      .send(`\uFEFF${csv}`);
  });
}
