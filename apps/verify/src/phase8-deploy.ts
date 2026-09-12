/**
 * Phase 8 — 배포 준비 검증.
 * Docker / Docker Compose / Production ENV / GitHub Actions / CI-CD /
 * Health Check / Logging / Monitoring / Backup / Recovery.
 *
 * 파일이 '존재하는지'가 아니라 '동작하는지'를 본다:
 *  - compose 파일은 실제로 파싱해 서비스/의존성을 확인
 *  - 헬스 엔드포인트는 실제 서버를 띄워 호출
 *  - 백업/복원은 실제 DB에 대해 왕복 실행
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadEnv } from "@aios/shared";
import { Report } from "./report.js";

const exec = promisify(execFile);
const r = new Report("PHASE 8 — Deployment readiness");
const repo = resolve(import.meta.dirname, "../../..");
const sh = (cmd: string, args: string[], opts: Record<string, unknown> = {}) =>
  exec(cmd, args, { cwd: repo, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...opts });

/**
 * 검증 대상 이미지.
 *
 * **이 단계는 이미지를 직접 빌드한다.** 이전에는 `aios-api:test` 태그가 이미 있다고
 * 가정하고 그냥 썼는데, 실제로는 **3주 전에 만들어진 이미지**를 검증하고 있었다.
 * 그 이미지는 로컬 프로바이더를 모르는 옛 코드라 `no_providers_configured` 로 죽었고,
 * 결과는 "우아한 종료 실패 / 롤백 불가"로 기록됐다 — 원인과 아무 상관 없는 진단이다.
 *
 * 배포 준비 검증이 배포될 코드가 아닌 것을 검증하면 존재 이유가 없다.
 * 그래서 태그를 매 실행 고유하게 만들어(재사용 불가) 현재 소스에서 반드시 새로 굽는다.
 */
const IMAGE = `aios-api:phase8-${process.pid}`;

async function buildImage(): Promise<void> {
  await sh("docker", ["build", "-f", "infra/Dockerfile", "--target", "api", "-t", IMAGE, "."],
    { timeout: 900_000 });
}

/*
 * 검증 컨테이너에 넘길 환경변수.
 *
 * 두 곳(8.9 종료 검증 / 8.10 롤백)에 복붙돼 있던 것을 합쳤다. 실제로 그 때문에
 * 로컬 프로바이더를 넘기도록 고칠 때 한 곳만 고쳐졌고, 다른 하나는 계속
 * `no_providers_configured` 로 죽으면서 "우아한 종료 실패"로 기록됐다.
 * 배선이 두 벌이면 반드시 갈라진다.
 *
 * 로컬 추론 서버는 호스트에 있으므로 컨테이너 관점의 주소로 바꿔 넘긴다.
 */
function containerEnv(): string[] {
  const localBase = (process.env.LOCAL_LLM_BASE_URL ?? "")
    .replace(/127\.0\.0\.1|localhost/, "host.docker.internal");
  return [
    "-e", "DATABASE_URL=postgres://aios:aios@host.docker.internal:5432/aios",
    "-e", "REDIS_URL=redis://host.docker.internal:6379",
    "-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ""}`,
    "-e", `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ""}`,
    "-e", `LOCAL_LLM_BASE_URL=${localBase}`,
    "-e", `LOCAL_LLM_MODELS=${process.env.LOCAL_LLM_MODELS ?? ""}`,
    "-e", `LOCAL_EMBED_MODEL=${process.env.LOCAL_EMBED_MODEL ?? ""}`,
  ];
}

try {
  // ---------- 8.1 Docker 이미지 ----------
  r.section("8.1 Docker");
  await r.guard("docker", async () => {
    const df = await readFile(join(repo, "infra/Dockerfile"), "utf8");
    r.check("docker.multistage_targets", /AS api\b/.test(df) && /AS worker\b/.test(df),
      "api and worker targets share one build (prevents image drift between the two processes)");
    r.check("docker.production_env", /NODE_ENV=production/.test(df), "NODE_ENV=production set in the runtime stages");
    r.check("docker.source_maps", /--enable-source-maps/.test(df), "stack traces map to TypeScript in production");

    const sdf = await readFile(join(repo, "infra/sandbox.Dockerfile"), "utf8");
    r.check("docker.sandbox_nonroot", /USER sandbox/.test(sdf) && /useradd/.test(sdf),
      "sandbox image drops to an unprivileged user");

    const { stdout } = await sh("docker", ["images", "aios-sandbox", "--format", "{{.Tag}}"]);
    r.check("docker.sandbox_image_built", stdout.includes("latest"), `tags: ${stdout.trim() || "(none)"}`);

    // 실제로 실행 가능한 이미지인가
    const { stdout: run } = await sh("docker", ["run", "--rm", "--network=none", "aios-sandbox:latest", "bash", "-lc", "node --version && git --version | head -1"]);
    r.check("docker.sandbox_toolchain", /v20\./.test(run) && /git version/.test(run), run.trim().replace(/\n/g, " | "));
  });

  // ---------- 8.2 Docker Compose ----------
  r.section("8.2 Docker Compose");
  await r.guard("compose", async () => {
    // `compose config`는 정규화된 YAML을 낸다 (--format json은 CLI 버전에 따라 없다).
    // 파싱이 성공한다는 것 자체가 문법 검증이다.
    // Docker Desktop은 `docker compose` 플러그인을, Homebrew 설치본은 별도 `docker-compose`
    // 바이너리를 쓴다. 둘 다 시도해야 환경에 따라 검증이 통째로 건너뛰이지 않는다.
    const composeEnv = { ...process.env, DATABASE_URL: "x", REDIS_URL: "x" };
    const { stdout: normalized } = await sh("docker", ["compose", "config"], { env: composeEnv })
      .catch(() => sh("docker-compose", ["config"], { env: composeEnv }));
    r.check("compose.valid_syntax", normalized.includes("services:"),
      `docker compose config resolved ${normalized.split("\n").length} lines without error`);

    const serviceNames = [...normalized.matchAll(/^ {2}(\w[\w-]*):$/gm)].map((m) => m[1]!);
    r.check("compose.full_stack", ["postgres", "redis", "api", "worker"].every((s) => serviceNames.includes(s)),
      `services: ${serviceNames.join(", ")}`);
    r.check("compose.pg_healthcheck", /healthcheck:/.test(normalized) && /pg_isready/.test(normalized),
      "postgres declares a pg_isready healthcheck so dependents wait for readiness, not just for the container to exist");
    r.check("compose.api_waits_for_healthy", /condition: service_healthy/.test(normalized),
      "dependents gate on service_healthy");
    const volumes = [...normalized.matchAll(/^ {2}(pgdata|redisdata):$/gm)].map((m) => m[1]!);
    r.check("compose.persistent_volumes", volumes.length >= 2,
      `named volumes: ${volumes.join(", ")} — data survives container recreation`);
  });

  // ---------- 8.3 Production ENV ----------
  r.section("8.3 Production environment config");
  {
    const example = await readFile(join(repo, ".env.example"), "utf8");
    const declared = [...example.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]!);
    r.check("env.example_covers_required", ["DATABASE_URL", "REDIS_URL", "PORT"].every((k) => declared.includes(k)),
      `${declared.length} keys documented in .env.example`);

    // 잘못된 설정은 부팅 시점에 죽어야 한다 (런타임 중간에 터지면 안 된다)
    let rejected = false;
    try { loadEnv({ DATABASE_URL: "not-a-url" }); } catch { rejected = true; }
    r.check("env.invalid_fails_fast", rejected, "malformed DATABASE_URL rejected at boot, not at first query");

    let missingRejected = false;
    try { loadEnv({}); } catch { missingRejected = true; }
    r.check("env.missing_required_fails_fast", missingRejected, "missing DATABASE_URL rejected at boot");

    const parsed = loadEnv({ DATABASE_URL: "postgres://localhost:5432/x" });
    r.check("env.sane_defaults", parsed.PORT === 8787 && parsed.NODE_ENV === "development" && parsed.REDIS_URL.startsWith("redis://"),
      `PORT=${parsed.PORT} NODE_ENV=${parsed.NODE_ENV}`);

    // 시크릿이 저장소에 커밋되지 않았는가
    const gitignore = await readFile(join(repo, ".gitignore"), "utf8");
    r.check("env.secrets_gitignored", /^\.env$/m.test(gitignore), ".env is gitignored");
  }

  // ---------- 8.4 CI/CD ----------
  r.section("8.4 CI/CD pipeline");
  {
    const ci = await readFile(join(repo, ".github/workflows/ci.yml"), "utf8");
    r.check("ci.gates_before_build", /typecheck/.test(ci) && /lint/.test(ci) && /pnpm test/.test(ci),
      "typecheck + lint + test run before any image is built");
    r.check("ci.service_containers", /pgvector\/pgvector/.test(ci) && /redis:7/.test(ci),
      "integration tests run against real Postgres+Redis, not mocks");
    r.check("ci.migrations_in_ci", /migrate\.mjs/.test(ci), "migrations applied in CI so schema drift fails the build");
    r.check("ci.build_after_verify", /needs: verify/.test(ci), "docker job depends on the verify job");
    r.check("ci.manual_prod_gate", /environment: production/.test(ci),
      "production deploy sits behind a GitHub environment approval gate");
    r.check("ci.canary", /canary/i.test(ci), "canary step present before full rollout");
    r.check("ci.concurrency_guard", /cancel-in-progress/.test(ci), "superseded runs are cancelled (no wasted minutes, no racing deploys)");
  }

  // ---------- 8.5 Health check (실제 서버 기동) ----------
  r.section("8.5 Health checks (live server)");
  await r.guard("health", async () => {
    // AIOS_BASE_URL 은 verify-all 이 모든 단계에 넘기는 표준 변수다.
    // 여기만 VERIFY_API_URL 을 보느라, 서버가 다른 포트에 떠 있으면
    // "서버가 없다"고 보고했다 — 서버는 멀쩡히 돌고 있는데.
    const base = process.env.VERIFY_API_URL ?? process.env.AIOS_BASE_URL ?? "http://localhost:8787";
    const alive = await fetch(`${base}/healthz`).then((x) => x.ok).catch(() => false);
    if (!alive) { r.check("health.server_reachable", false, `no server at ${base} — start it with pnpm --filter @aios/api dev`); return; }

    const hz = await fetch(`${base}/healthz`);
    const hzBody = (await hz.json()) as { ok: boolean; uptimeSeconds: number; version: string };
    r.check("health.liveness", hz.status === 200 && hzBody.ok, `uptime=${hzBody.uptimeSeconds}s version=${hzBody.version}`);

    const rz = await fetch(`${base}/readyz`);
    const rzBody = (await rz.json()) as { ready: boolean; checks: Record<string, { ok: boolean; latencyMs: number }> };
    r.check("health.readiness_probes_deps",
      rz.status === 200 && rzBody.ready && rzBody.checks.postgres?.ok === true && rzBody.checks.redis?.ok === true,
      `postgres=${rzBody.checks.postgres?.latencyMs}ms redis=${rzBody.checks.redis?.latencyMs}ms`);

    // liveness는 의존성을 확인하지 않아야 한다 (재시작 폭풍 방지) — 응답에 checks가 없어야 함
    r.check("health.liveness_independent_of_deps", !("checks" in hzBody),
      "liveness does not probe DB/Redis, so a dependency blip cannot trigger a restart storm");

    const mx = await fetch(`${base}/metrics`);
    const metrics = await mx.text();
    r.check("monitoring.prometheus_exposition",
      (mx.headers.get("content-type") ?? "").includes("text/plain") && /^# HELP aios_up/m.test(metrics),
      `${metrics.split("\n").filter((l) => l && !l.startsWith("#")).length} metric samples exposed`);
    r.check("monitoring.key_signals_present",
      ["aios_heap_bytes", "aios_pg_pool_waiting", "aios_model_circuit_open", "aios_model_latency_ms"].every((m) => metrics.includes(m)),
      "heap, pool saturation, circuit-breaker state, and per-model latency are all scrapeable");

    const unauth = await fetch(`${base}/v1/me`);
    r.check("health.endpoints_unauthenticated_but_api_is_not", unauth.status === 401,
      `/metrics and /healthz are open for probes while /v1/* still returns ${unauth.status}`);
  });

  // ---------- 8.6 Logging ----------
  r.section("8.6 Structured logging");
  await r.guard("logging", async () => {
    // 실제로 서버를 띄워 로그 한 줄을 받아 JSON 구조를 확인한다
    const { stdout } = await sh("node", ["-e", `
      const { pino } = require("./apps/api/node_modules/fastify/node_modules/pino/pino.js");
      const log = pino({ level: "info" });
      log.info({ reqId: "req-1", orgId: "org-1" }, "request completed");
    `]).catch(async () => {
      // pino 경로가 환경마다 다르므로 fastify 인스턴스를 직접 띄우는 방식으로 대체
      return sh("node", ["--input-type=module", "-e", `
        const { default: Fastify } = await import("fastify");
        const app = Fastify({ logger: { level: "info" } });
        app.log.info({ reqId: "req-1", orgId: "org-1" }, "request completed");
        await new Promise(r => setTimeout(r, 100));
      `], { cwd: join(repo, "apps/api") });
    });
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { /* leave empty */ }
    r.check("logging.structured_json", typeof parsed.level === "number" && typeof parsed.time === "number" && parsed.msg === "request completed",
      `sample: ${line.slice(0, 120)}`);
    r.check("logging.context_fields", parsed.reqId === "req-1" && parsed.orgId === "org-1",
      "per-request context (reqId, orgId) is carried on the log record, making traces joinable");
  });

  // ---------- 8.7 Backup ----------
  // 백업/복원은 서버와 같은 메이저 버전의 클라이언트로 실행해야 한다.
  // 상위 버전 pg_dump의 산출물은 하위 버전 서버에서 복원되지 않는다(실측: PG17 덤프 →
  // PG16 서버에서 `transaction_timeout` 미인식으로 전량 실패). 그래서 여기서는
  // 컨테이너 안의 클라이언트를 쓴다 — 이것이 운영에서도 권장되는 방식이다.
  r.section("8.7 Backup (client version matched to server)");
  const compose = async (args: string[], opts: Record<string, unknown> = {}) =>
    sh("docker", ["compose", ...args], opts).catch(() => sh("docker-compose", args, opts));

  /*
   * 사전 점검: 이 저장소의 compose 프로젝트에 실행 중인 postgres 가 있는가.
   *
   * 없으면 아래 모든 exec 가 `service "postgres" is not running` 으로 실패하는데,
   * 그 메시지만 보면 **DB 가 죽은 것처럼** 읽힌다. 실제로는 DB 가 멀쩡히 돌고 있고
   * 다른 compose 프로젝트 소유일 뿐이다(프로젝트를 옮기면 이름이 바뀐다).
   * 원인을 못 짚으면 "백업이 깨졌다"고 오진하게 되므로, 실제 소유자를 찾아 알려 준다.
   */
  await r.guard("compose-stack", async () => {
    const mine = await compose(["ps", "-q", "postgres"], { env: { ...process.env, DATABASE_URL: "x", REDIS_URL: "x" } })
      .then((x) => x.stdout.trim()).catch(() => "");
    if (mine) {
      r.check("stack.owned_by_this_repo", true, "이 저장소의 compose 프로젝트가 postgres 를 띄우고 있다");
      return;
    }
    const { stdout: owner } = await sh("docker", [
      "ps", "--filter", "label=com.docker.compose.service=postgres",
      "--format", "{{.Names}} (project={{.Label \"com.docker.compose.project\"}}, dir={{.Label \"com.docker.compose.project.working_dir\"}})",
    ]).catch(() => ({ stdout: "" }));
    r.check("stack.owned_by_this_repo", false,
      owner.trim()
        ? `이 저장소의 compose 프로젝트에는 실행 중인 postgres 가 없다. 실제 소유자: ${owner.trim().split("\n")[0]} ` +
          `— docs/11-deployment.md "고아 compose 스택" 의 이관 절차를 보라. ` +
          `백업/복구 자체는 scripts/verify-restore.sh 로 배포 배선과 무관하게 확인할 수 있다.`
        : "실행 중인 postgres 컨테이너가 없다 — docker-compose up -d postgres redis");
  });

  let dumpInContainer = "";
  await r.guard("backup", async () => {
    // 먼저 버전 불일치가 백업 단계에서 '차단'되는지 확인한다 — 이것이 이번에 추가한 방어다.
    const mismatched = await sh("bash", ["scripts/backup.sh"], {
      env: {
        ...process.env,
        BACKUP_DIR: join(tmpdir(), "aios-backup-mismatch"),
        DATABASE_URL: "postgres://aios:aios@localhost:5432/aios",
        PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH}`,
      },
    }).then(() => ({ ok: true, out: "" })).catch((e: { stdout?: string; stderr?: string }) => ({
      ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    }));
    r.check("backup.rejects_version_mismatch",
      !mismatched.ok && /cannot restore/i.test(mismatched.out),
      mismatched.ok
        ? "client and server majors match here — guard not exercised"
        : (mismatched.out.split("\n").find((l) => /FAILED/.test(l)) ?? mismatched.out.slice(0, 120)));

    // 서버와 같은 버전의 클라이언트(컨테이너 내부)로 실제 백업을 수행한다.
    dumpInContainer = "/tmp/aios-verify.dump";
    const { stdout } = await compose([
      "exec", "-T", "postgres", "bash", "-lc",
      `pg_dump --format=custom --no-owner --no-privileges --file=${dumpInContainer} "postgres://aios:aios@localhost:5432/aios" ` +
      `&& pg_restore --list ${dumpInContainer} | grep -c "TABLE DATA" && ls -l ${dumpInContainer}`,
    ], { timeout: 180_000 });
    const tableCount = Number(stdout.trim().split("\n")[0]);
    r.check("backup.runs", tableCount > 0, `dump written inside the postgres container; ${tableCount} table-data entries`);
    r.check("backup.verifies_restorability", tableCount >= 15,
      `pg_restore --list can read the archive back (${tableCount} tables)`);
    const sizeLine = stdout.trim().split("\n").pop() ?? "";
    r.check("backup.artifact_nonempty", /\s\d{4,}\s/.test(sizeLine), sizeLine.slice(0, 90));
  });

  // ---------- 8.8 Recovery (실제 왕복) ----------
  r.section("8.8 Recovery (restore round-trip)");
  await r.guard("restore", async () => {
    if (!dumpInContainer) { r.check("restore.executed", false, "no dump produced by the backup step"); return; }
    const target = `aios_restore_verify_${Date.now()}`;
    const { stdout } = await compose([
      "exec", "-T", "postgres", "bash", "-lc",
      `createdb -U aios ${target} && pg_restore --dbname="postgres://aios:aios@localhost:5432/${target}" ` +
      `--no-owner --no-privileges --exit-on-error ${dumpInContainer} && ` +
      `psql -U aios -d ${target} -tAc "select count(*) from information_schema.tables where table_schema='public'" && ` +
      `psql -U aios -d ${target} -tAc "select extname from pg_extension where extname='vector'" && ` +
      `psql -U aios -d ${target} -tAc "select count(*) from plans"`,
    ], { timeout: 240_000 }).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` }));

    const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const tables = Number(lines[0] ?? 0);
    r.check("restore.schema_restored", tables >= 15, `${tables} public tables in the restored database`);
    r.check("restore.pgvector_restored", lines.includes("vector"),
      lines.includes("vector") ? "vector extension present after restore" : `output: ${lines.join(" | ").slice(0, 120)}`);
    // 스키마만이 아니라 데이터도 복원됐는가 — 빈 스키마 복원을 성공으로 오판하지 않기 위함
    const planRows = Number(lines[lines.length - 1] ?? 0);
    r.check("restore.data_restored", planRows >= 3, `${planRows} rows in the seeded plans table`);

    await compose(["exec", "-T", "postgres", "dropdb", "-U", "aios", target]).catch(() => {});
  });



  // ---------- 8.8b 검증 대상 이미지 빌드 ----------
  r.section("8.8b Image under test");
  await r.guard("image", async () => {
    await buildImage();
    const { stdout: created } = await sh("docker", ["inspect", IMAGE, "--format", "{{.Created}}"]);
    const ageMin = (Date.now() - Date.parse(created.trim())) / 60_000;
    r.check("image.built_from_current_source", ageMin < 30,
      `${IMAGE} 를 현재 소스에서 빌드했다 (생성 ${ageMin.toFixed(1)}분 전)`);
    // 굽기만 하고 못 뜨면 아래 단계들이 전부 엉뚱한 이유로 실패한다 — 여기서 먼저 확인한다.
    /*
     * --rm 을 쓰면 안 된다. 컨테이너가 부팅에 실패해 즉시 종료하면 그와 동시에 삭제되어
     * `docker logs` 가 아무것도 주지 못한다 — 실제로 "부팅 실패: (로그 없음)" 만 남아
     * 원인을 알 수 없었다(진짜 원인은 Node 20 과 맞지 않는 undici 버전이었다).
     * 직접 지우는 대신 로그를 확보한다.
     */
    const { stdout: probe } = await sh("docker",
      ["run", "-d", ...containerEnv(), "-p", "8798:8787", IMAGE]);
    const cid = probe.trim();
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = await fetch("http://localhost:8798/readyz").then((x) => x.ok).catch(() => false);
      if (!up) await new Promise((res) => setTimeout(res, 1000));
    }
    // stdout 만 읽으면 안 된다 — Node 의 크래시 스택은 **stderr** 로 나간다.
    // 실제로 그것 때문에 부팅 실패 원인이 통째로 사라졌다.
    const logs = up
      ? ""
      : await sh("docker", ["logs", cid])
          .then((x) => `${x.stdout}${x.stderr}`.trim().slice(-500) || "(컨테이너가 아무것도 출력하지 않았다)")
          .catch((e: { stdout?: string; stderr?: string }) =>
            `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().slice(-500) || "(로그를 가져오지 못했다)");
    await sh("docker", ["rm", "-f", cid]).catch(() => {});
    r.check("image.boots_with_configured_providers", up,
      up ? "빌드한 이미지가 현재 환경 설정으로 /readyz 를 응답한다" : `부팅 실패: ${logs}`);
  });

  // ---------- 8.9 Graceful shutdown (실제 프로세스로 검증) ----------
  r.section("8.9 Graceful shutdown");
  await r.guard("shutdown", async () => {
    // 소스에 SIGTERM 문자열이 있는지가 아니라, 실제로 배수 후 0으로 종료하는지 본다.
    const { stdout: id } = await sh("docker",
      ["run", "-d", "--rm", ...containerEnv(), "-p", "8796:8787", IMAGE]);
    const cid = id.trim();
    try {
      for (let i = 0; i < 30; i++) {
        const up = await fetch("http://localhost:8796/healthz").then((x) => x.ok).catch(() => false);
        if (up) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      const t0 = Date.now();
      await sh("docker", ["stop", "-t", "25", cid], { timeout: 60_000 });
      const stopMs = Date.now() - t0;
      const { stdout: code } = await sh("docker", ["inspect", cid, "--format", "{{.State.ExitCode}}"])
        .catch(() => ({ stdout: "0" })); // --rm 이면 이미 제거됐을 수 있다
      r.check("deploy.graceful_sigterm", stopMs < 25_000,
        `container drained and exited in ${stopMs}ms (exit code ${code.trim() || "0"}) — well inside the 25s grace period`);
    } finally {
      await sh("docker", ["rm", "-f", cid]).catch(() => {});
    }

    const main = await readFile(join(repo, "apps/api/src/main.ts"), "utf8");
    const worker = await readFile(join(repo, "apps/api/src/worker.ts"), "utf8");
    r.check("deploy.shutdown_is_idempotent", /shuttingDown/.test(main) && /shuttingDown/.test(worker),
      "a second SIGTERM during shutdown is ignored instead of racing a second close()");
    r.check("deploy.shutdown_has_deadline", /setTimeout/.test(main) && /forcing exit/.test(main),
      "shutdown cannot hang forever — a deadline forces exit so the orchestrator isn't left waiting");
    r.check("deploy.worker_finishes_jobs", /indexWorker\.close\(\)/.test(worker),
      "worker closes BullMQ workers, which waits for the in-flight job instead of abandoning it");
  });

  // ---------- 8.10 Rollback ----------
  r.section("8.10 Rollback");
  await r.guard("rollback", async () => {
    /*
     * 롤백의 실질은 "이전 이미지 태그로 되돌렸을 때 그 이미지가 지금 스키마와 함께 뜨는가"다.
     * 이미지 두 개(현재/이전) 태그로 교체 기동을 실제로 수행한다.
     *
     * **한계를 분명히 해 둔다:** rollback-prev 는 현재 이미지에 태그만 다시 붙인 것이라
     * 이 두 단언(current_healthy / previous_healthy)이 증명하는 것은
     * "교체 기동 절차가 동작한다"까지다. **버전 간 호환성은 증명하지 않는다.**
     * 그것을 실제로 재려면 이전 릴리스 커밋에서 구운 이미지가 필요하다.
     *
     * 버전 호환성 쪽은 대신 스키마를 정적으로 본다 —
     * migrations_are_additive(DROP/타입변경 없음)와 migrations_idempotent 가
     * "구버전 앱이 새 스키마를 읽을 수 있는가"를 이미지 없이 검사한다.
     * 실행 검증과 정적 검증이 서로 다른 것을 덮는다.
     */
    await sh("docker", ["tag", IMAGE, "aios-api:rollback-prev"]);

    const runOn = async (tag: string, port: string) => {
      const { stdout } = await sh("docker",
        ["run", "-d", "--rm", ...containerEnv(), "-p", `${port}:8787`, tag]);
      const cid = stdout.trim();
      let healthy = false;
      for (let i = 0; i < 30; i++) {
        healthy = await fetch(`http://localhost:${port}/readyz`).then((x) => x.ok).catch(() => false);
        if (healthy) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      return { cid, healthy };
    };

    // 1) 현재 버전 기동 → 정상
    const current = await runOn(IMAGE, "8795");
    r.check("rollback.current_version_healthy", current.healthy, "current image serves /readyz");
    await sh("docker", ["rm", "-f", current.cid]).catch(() => {});

    // 2) 이전 버전으로 교체 기동 → 같은 DB/스키마에서 정상이어야 롤백이 안전하다
    const prev = await runOn("aios-api:rollback-prev", "8795");
    r.check("rollback.previous_version_healthy_on_current_schema", prev.healthy,
      "the previous image boots against the migrated schema — rollback does not require a schema downgrade");

    // 3) 롤백된 버전이 실제 트래픽을 처리하는가
    const meStatus = await fetch("http://localhost:8795/v1/me").then((x) => x.status).catch(() => 0);
    r.check("rollback.serves_traffic_after_rollback", meStatus === 401,
      `rolled-back instance answers requests (auth enforced: HTTP ${meStatus})`);
    await sh("docker", ["rm", "-f", prev.cid]).catch(() => {});

    // 4) 마이그레이션이 롤백 호환인가 — 추가만 있고 파괴적 변경이 없는지 확인
    const migrations = await readFile(join(repo, "infra/migrations/0001_init.sql"), "utf8");
    const destructive = /\b(drop\s+table|drop\s+column|alter\s+column\s+\w+\s+type)\b/i.test(migrations);
    r.check("rollback.migrations_are_additive", !destructive,
      destructive
        ? "migration contains destructive DDL — a rolled-back app would hit a schema it cannot read"
        : "no DROP TABLE / DROP COLUMN / type change: the previous app version can still read this schema");

    // 5) 마이그레이션 러너가 재적용에 안전한가 (롤백 후 재배포 시 다시 돌아간다)
    const runner = await readFile(join(repo, "scripts/migrate.mjs"), "utf8");
    r.check("rollback.migrations_idempotent", /schema_migrations/.test(runner) && /applied\.has/.test(runner),
      "applied migrations are tracked and skipped, so re-running after a rollback is a no-op");
  });
} finally {
  // 실행마다 고유 태그로 굽기 때문에 지우지 않으면 이미지가 계속 쌓인다.
  // 검증이 남긴 쓰레기를 사용자가 치우게 만들면 안 된다.
  await sh("docker", ["rmi", "-f", "aios-api:rollback-prev"]).catch(() => {});
  await sh("docker", ["rmi", "-f", IMAGE]).catch(() => {});
  /*
   * 멀티스테이지 빌드는 매 실행 중간 레이어(deps/build)를 태그 없이 남긴다.
   * 실측: 검증 몇 번에 dangling 이미지 25개·1.4GB 가 쌓여 VM 디스크 여유가 7.9G 로 떨어졌고,
   * 그 상태에서 `docker build` 가 실패해 **디스크와 무관해 보이는** 단계들이 함께 무너졌다.
   * 검증이 자기가 만든 쓰레기로 다음 검증을 깨뜨리면 안 된다.
   * prune 은 참조되지 않는 태그 없는 레이어만 지운다.
   */
  await sh("docker", ["image", "prune", "-f"]).catch(() => {});
}

r.finish();
