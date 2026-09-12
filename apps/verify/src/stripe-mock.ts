import { createServer, type Server } from "node:http";

/**
 * Stripe API 목 서버.
 *
 * 왜 목인가: 실제 Stripe 계정 없이도 아웃바운드 경로(form 인코딩, 멱등성 헤더,
 * 재시도, 응답 파싱)를 진짜 HTTP로 검증해야 한다. 클라이언트를 스텁으로 갈아끼우면
 * 정작 검증하고 싶은 직렬화·헤더·재시도 코드가 실행되지 않는다.
 *
 * 이 목은 두 가지를 실제로 흉내 낸다:
 *  1) 멱등성 — 같은 idempotency-key로 온 요청은 최초 응답을 그대로 반환
 *  2) 일시적 5xx — /v1/customers 첫 호출은 500을 던져 재시도 로직을 실제로 태운다
 */
export interface MockRecord {
  path: string;
  body: string;
  idempotencyKey: string | null;
  authorization: string | null;
}

export interface StripeMock {
  url: string;
  requests: MockRecord[];
  close(): Promise<void>;
  /** 다음 N개 요청에 500을 반환하도록 설정 (재시도 검증용) */
  failNext(count: number): void;
}

export async function startStripeMock(): Promise<StripeMock> {
  const requests: MockRecord[] = [];
  const idempotencyCache = new Map<string, string>();
  let failuresRemaining = 0;
  let counter = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const key = (req.headers["idempotency-key"] as string | undefined) ?? null;
      requests.push({
        path: req.url ?? "",
        body,
        idempotencyKey: key,
        authorization: req.headers.authorization ?? null,
      });

      if (failuresRemaining > 0) {
        failuresRemaining--;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "transient upstream error" } }));
        return;
      }

      if (key && idempotencyCache.has(key)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(idempotencyCache.get(key));
        return;
      }

      counter++;
      let payload: Record<string, unknown>;
      if (req.url?.startsWith("/v1/customers")) {
        payload = { id: `cus_mock_${counter}`, object: "customer" };
      } else if (req.url?.startsWith("/v1/checkout/sessions")) {
        payload = { id: `cs_mock_${counter}`, url: `https://checkout.stripe.test/pay/cs_mock_${counter}` };
      } else if (req.url?.startsWith("/v1/billing_portal/sessions")) {
        payload = { url: `https://billing.stripe.test/session/${counter}` };
      } else if (req.url?.startsWith("/v1/subscriptions/")) {
        const atEnd = /cancel_at_period_end=true/.test(body);
        payload = { id: "sub_mock", status: atEnd ? "active" : "canceled", cancel_at_period_end: atEnd };
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `unmocked path ${req.url}` } }));
        return;
      }
      const json = JSON.stringify(payload);
      if (key) idempotencyCache.set(key, json);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(json);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("mock server has no port");

  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    failNext: (count) => { failuresRemaining = count; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
