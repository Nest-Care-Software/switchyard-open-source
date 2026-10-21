import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, before, beforeEach, describe, it } from "node:test";

import {
  parseUsageRecord,
  type UsageRecord,
  type WeeklyReportPayload,
} from "@switchyard/reporting";

import { AccessJwksCache } from "../src/auth.js";
import { FakeD1Database } from "../src/testing/fake-d1.js";
import {
  handleRequest,
  handleScheduled,
  RETENTION_CRON,
  WEEKLY_REPORT_CRON,
  type ReportingWorkerEnvironment,
} from "../src/worker.js";

const MIGRATION_SQL = readFileSync("migrations/0001_reporting.sql", "utf8");
const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "switchyard-reporting-audience";
const NOW = new Date("2026-08-24T08:00:00.000Z");

let database: FakeD1Database;
let environment: ReportingWorkerEnvironment;
let accessAssertion: string;
let publicJwk: JsonWebKey & { kid: string };

before(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "worker-test-key",
    alg: "RS256",
    use: "sig",
  };
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);
  const header = encodeJson({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" });
  const claims = encodeJson({
    type: "app",
    aud: [AUDIENCE],
    exp: nowSeconds + 300,
    iss: ISSUER,
    iat: nowSeconds,
    sub: "",
    common_name: "service-token.access",
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  accessAssertion = `${header}.${claims}.${encodeBytes(new Uint8Array(signature))}`;
});

beforeEach(() => {
  database = new FakeD1Database(MIGRATION_SQL);
  environment = {
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: AUDIENCE,
    REPORTING_DB: database,
  };
});

afterEach(() => {
  database.close();
});

describe("fixed reporting Worker boundary", () => {
  it("fails closed before routing when Access authentication is missing or malformed", async () => {
    const missing = await handleRequest(
      new Request("https://reporting.example.test/v1/reports/7"),
      environment,
      dependencies(),
    );
    assert.equal(missing.status, 401);

    const malformed = await handleRequest(
      new Request("https://reporting.example.test/v1/reports/7", {
        headers: { "Cf-Access-Jwt-Assertion": "malformed" },
      }),
      environment,
      dependencies(),
    );
    assert.equal(malformed.status, 401);
    assert.equal(database.statements.length, 0);
  });

  it("exposes one strict idempotent write and reports replay or conflict", async () => {
    const record = usageRecord();
    const created = await handleRequest(
      usageRequest("allocation:123", record),
      environment,
      dependencies(),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { status: "created" });

    const replayed = await handleRequest(
      usageRequest("allocation:123", record),
      environment,
      dependencies(),
    );
    assert.equal(replayed.status, 200);
    assert.deepEqual(await replayed.json(), { status: "replayed" });

    const conflict = await handleRequest(
      usageRequest("allocation:123", { ...record, estimated_cost_usd_cents: 43 }),
      environment,
      dependencies(),
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });
  });

  it("rejects forbidden and unknown fields without storing detail", async () => {
    for (const field of ["machine_sku", "branch", "actor", "logs", "source", "message", "secret"]) {
      const response = await handleRequest(
        usageRequest(`allocation:${field}`, { ...usageRecord(), [field]: "forbidden" }),
        environment,
        dependencies(),
      );
      assert.equal(response.status, 400, field);
    }
    assert.equal(database.query("SELECT * FROM usage_records").length, 0);
  });

  it("rejects sensitive text and mixed reporting dimensions before D1", async () => {
    for (const [index, dimensions] of [
      { repository: "example-org/customer-password" },
      { workflow: ".github/workflows/production-secret.yml" },
      { job: "runner_log_access_token" },
      {
        repository: "example-org/example-workload",
        workflow: ".github/workflows/other.yml",
        job: "example-build",
      },
    ].entries()) {
      const response = await handleRequest(
        usageRequest(`allocation:dimension:${index}`, { ...usageRecord(), ...dimensions }),
        environment,
        dependencies(),
      );
      assert.equal(response.status, 400, JSON.stringify(dimensions));
    }
    assert.equal(database.statements.length, 0);
  });

  it("rejects malformed write transport before D1", async () => {
    const missingKey = authenticatedRequest("/v1/usage-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(usageRecord()),
    });
    assert.equal((await handleRequest(missingKey, environment, dependencies())).status, 400);

    const malformedJson = authenticatedRequest("/v1/usage-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "allocation:json" },
      body: "{",
    });
    assert.equal((await handleRequest(malformedJson, environment, dependencies())).status, 400);

    const wrongContentType = authenticatedRequest("/v1/usage-records", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": "allocation:text" },
      body: JSON.stringify(usageRecord()),
    });
    assert.equal((await handleRequest(wrongContentType, environment, dependencies())).status, 415);

    const oversized = authenticatedRequest("/v1/usage-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "allocation:large" },
      body: JSON.stringify({ padding: "x".repeat(17 * 1_024) }),
    });
    assert.equal((await handleRequest(oversized, environment, dependencies())).status, 413);
    assert.equal(database.statements.length, 0);
  });

  it("allows only fixed report paths and never accepts SQL, table names or query parameters", async () => {
    const cases: ReadonlyArray<[string, string, number]> = [
      ["GET", "/v1/reports/7?sql=SELECT+*", 400],
      ["GET", "/v1/reports/14", 405],
      ["POST", "/v1/reports/7", 405],
      ["POST", "/v1/query", 404],
      ["GET", "/v1/tables/usage_records", 404],
      ["DELETE", "/v1/usage-records", 405],
    ];

    for (const [method, path, expectedStatus] of cases) {
      const response = await handleRequest(
        authenticatedRequest(path, { method }),
        environment,
        dependencies(),
      );
      assert.equal(response.status, expectedStatus, `${method} ${path}`);
    }

    for (const days of [7, 30, 365]) {
      const response = await handleRequest(
        authenticatedRequest(`/v1/reports/${days}`),
        environment,
        dependencies(),
      );
      assert.equal(response.status, 200, String(days));
      assert.equal(((await response.json()) as { window_days: number }).window_days, days);
    }
  });

  it("returns reporting unavailability only as telemetry HTTP state", async () => {
    database.failNextBatchAt(0);
    const response = await handleRequest(
      usageRequest("allocation:outage", usageRecord()),
      environment,
      dependencies(),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "reporting_unavailable" });
  });

  it("generates the Monday 08:00 UTC weekly payload and runs retention separately", async () => {
    const sent: WeeklyReportPayload[] = [];
    environment = {
      ...environment,
      WEEKLY_REPORT_SINK: {
        async send(payload) {
          sent.push(payload);
        },
      },
    };
    const payload = await handleScheduled(
      { cron: WEEKLY_REPORT_CRON, scheduledTime: NOW.getTime() },
      environment,
    );
    assert.equal(payload?.kind, "switchyard-weekly-report-v1");
    assert.deepEqual(sent, [payload]);

    assert.equal(
      await handleScheduled({ cron: RETENTION_CRON, scheduledTime: NOW.getTime() }, environment),
      undefined,
    );
    await assert.rejects(() =>
      handleScheduled({ cron: "* * * * *", scheduledTime: NOW.getTime() }, environment),
    );
  });
});

function dependencies() {
  return {
    now: NOW,
    accessJwt: {
      now: NOW,
      cache: new AccessJwksCache(),
      fetch: async () => Response.json({ keys: [publicJwk] }),
    },
  };
}

function authenticatedRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", accessAssertion);
  return new Request(`https://reporting.example.test${path}`, { ...init, headers });
}

function usageRequest(idempotencyKey: string, record: unknown): Request {
  return authenticatedRequest("/v1/usage-records", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(record),
  });
}

function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  const githubRunId = overrides.github_run_id ?? "1234567890";
  return parseUsageRecord({
    repository: "example-org/example-workload",
    workflow: ".github/workflows/ci.yml",
    job: "example-build",
    github_run_id: githubRunId,
    github_run_url: `https://github.com/example-org/example-workload/actions/runs/${githubRunId}`,
    provider: "azure",
    capability_profile: "linux-x64-large",
    started_at: "2026-08-24T07:55:00.000Z",
    completed_at: "2026-08-24T08:00:00.000Z",
    duration_ms: 300_000,
    outcome: "success",
    fallback_used: false,
    cleanup_problem: false,
    estimated_cost_usd_cents: 42,
    ...overrides,
  });
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
