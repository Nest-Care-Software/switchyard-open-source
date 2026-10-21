import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { parseUsageRecord, type UsageRecord } from "@switchyard/reporting";

import { D1ReportingStore, retentionCutoff } from "../src/d1-store.js";
import { FakeD1Database } from "../src/testing/fake-d1.js";

const MIGRATION_SQL = readFileSync("migrations/0001_reporting.sql", "utf8");
const NOW = new Date("2026-08-25T12:00:00.000Z");

let database: FakeD1Database;
let store: D1ReportingStore;

beforeEach(() => {
  database = new FakeD1Database(MIGRATION_SQL);
  store = new D1ReportingStore(database);
});

afterEach(() => {
  database.close();
});

describe("D1 reporting store", () => {
  it("checks in a strict schema containing only allowlisted detail and integrity metadata", () => {
    const usageColumns = database
      .query<{ name: string }>("PRAGMA table_info(usage_records)")
      .map((column) => column.name);
    assert.deepEqual(usageColumns, [
      "idempotency_key_hash",
      "repository",
      "workflow",
      "job",
      "github_run_id",
      "github_run_url",
      "provider",
      "capability_profile",
      "started_at",
      "completed_at",
      "duration_ms",
      "outcome",
      "fallback_used",
      "cleanup_problem",
      "estimated_cost_usd_cents",
    ]);
    for (const forbidden of [
      "machine",
      "sku",
      "branch",
      "actor",
      "log",
      "source",
      "message",
      "secret",
    ]) {
      assert.equal(
        usageColumns.some((column) => column.includes(forbidden)),
        false,
        forbidden,
      );
    }
  });

  it("creates an idempotent record, accepts an exact replay and rejects a conflict", async () => {
    const record = usageRecord();
    assert.equal(await store.writeUsageRecord("allocation:123", record), "created");
    assert.equal(await store.writeUsageRecord("allocation:123", record), "replayed");
    assert.equal(
      await store.writeUsageRecord("allocation:123", {
        ...record,
        estimated_cost_usd_cents: record.estimated_cost_usd_cents + 1,
      }),
      "conflict",
    );

    assert.equal(database.query("SELECT * FROM usage_records").length, 1);
    assert.equal(database.query("SELECT * FROM usage_record_idempotency").length, 1);
  });

  it("rolls back both idempotency and detail when an atomic write statement fails", async () => {
    database.failNextBatchAt(1);
    await assert.rejects(() => store.writeUsageRecord("allocation:123", usageRecord()));

    assert.equal(database.query("SELECT * FROM usage_records").length, 0);
    assert.equal(database.query("SELECT * FROM usage_record_idempotency").length, 0);
  });

  it("uses fixed SQL with bound values and rejects SQL-shaped dimensions before D1", async () => {
    const record = usageRecord();
    await store.writeUsageRecord("allocation:sql-injection", record);

    const insert = database.statements.find((statement) =>
      statement.sql.includes("INSERT INTO usage_records"),
    );
    assert.ok(insert);
    assert.equal(insert.sql.includes(record.job), false);
    assert.equal(insert.values.includes(record.job), true);
    assert.equal(database.query("SELECT count(*) AS count FROM usage_records")[0]?.count, 1);
    await assert.rejects(() =>
      store.writeUsageRecord("allocation:adversarial", {
        ...record,
        job: "DROP_TABLE_usage_records",
      }),
    );
  });

  it("enforces the exact V1 reporting dimensions in D1 as defence in depth", async () => {
    await store.writeUsageRecord("allocation:constraints", usageRecord());
    const insert = database.statements.find((statement) =>
      statement.sql.includes("INSERT INTO usage_records"),
    );
    assert.ok(insert);
    database.execute("DELETE FROM usage_records", []);

    for (const [valueIndex, adversarialValue] of [
      [2, "example-org/customer-password"],
      [3, ".github/workflows/production-secret.yml"],
      [4, "runner_log_access_token"],
    ] as const) {
      const values = [...insert.values];
      values[valueIndex] = adversarialValue;
      assert.throws(() => database.execute(insert.sql, values), /constraint failed/i);
    }
  });

  it("builds only a fixed bound report window", async () => {
    await store.writeUsageRecord(
      "allocation:inside",
      usageRecordEndingAt("2026-08-24T12:00:00.000Z", 300_000),
    );
    await store.writeUsageRecord(
      "allocation:outside",
      usageRecordEndingAt("2026-08-17T11:59:59.999Z", 300_000, { github_run_id: "2" }),
    );

    const report = await store.buildReport(7, NOW);
    assert.equal(report.usage.total_allocations, 1);
    assert.equal(report.slow_jobs[0]?.github_run_id, "1234567890");

    const select = database.statements.find(
      (statement) =>
        statement.sql.includes("FROM usage_records") &&
        statement.sql.includes("completed_at >= ?1"),
    );
    assert.deepEqual(select?.values, ["2026-08-18T12:00:00.000Z", "2026-08-25T12:00:00.000Z"]);
  });

  it("summarises complete expired UTC days exactly before deleting detail", async () => {
    const oldAzure = usageRecordEndingAt("2025-08-23T23:59:59.999Z", 60_000, {
      github_run_id: "10",
      estimated_cost_usd_cents: 10,
    });
    const oldFallback = usageRecordEndingAt("2025-08-24T00:00:00.000Z", 120_000, {
      github_run_id: "11",
      provider: "blacksmith",
      fallback_used: true,
      outcome: "failure",
      cleanup_problem: true,
      estimated_cost_usd_cents: 20,
    });
    const retainedBoundary = usageRecordEndingAt("2025-08-25T00:00:00.000Z", 1, {
      github_run_id: "12",
    });
    await store.writeUsageRecord("allocation:old-azure", oldAzure);
    await store.writeUsageRecord("allocation:old-fallback", oldFallback);
    await store.writeUsageRecord("allocation:boundary", retainedBoundary);

    assert.equal(retentionCutoff(NOW), "2025-08-25T00:00:00.000Z");
    assert.deepEqual(await store.runRetention(NOW), ["2025-08-23", "2025-08-24"]);
    assert.equal(database.query("SELECT * FROM usage_records").length, 1);
    assert.equal(
      database.query<{ count: number }>(
        "SELECT count(*) AS count FROM usage_record_idempotency WHERE detail_retired = 1",
      )[0]?.count,
      2,
    );

    const summaries = database.query<{
      cleanup_problem_count: number;
      estimated_cost_usd_cents: number;
      fallback_count: number;
      maximum_duration_ms: number;
      summary_date: string;
      total_duration_ms: number;
      usage_count: number;
    }>("SELECT * FROM daily_summaries ORDER BY summary_date");
    assert.deepEqual(
      summaries.map((summary) => ({
        summary_date: summary.summary_date,
        usage_count: summary.usage_count,
        total_duration_ms: summary.total_duration_ms,
        maximum_duration_ms: summary.maximum_duration_ms,
        estimated_cost_usd_cents: summary.estimated_cost_usd_cents,
        fallback_count: summary.fallback_count,
        cleanup_problem_count: summary.cleanup_problem_count,
      })),
      [
        {
          summary_date: "2025-08-23",
          usage_count: 1,
          total_duration_ms: 60_000,
          maximum_duration_ms: 60_000,
          estimated_cost_usd_cents: 10,
          fallback_count: 0,
          cleanup_problem_count: 0,
        },
        {
          summary_date: "2025-08-24",
          usage_count: 1,
          total_duration_ms: 120_000,
          maximum_duration_ms: 120_000,
          estimated_cost_usd_cents: 20,
          fallback_count: 1,
          cleanup_problem_count: 1,
        },
      ],
    );
    assert.deepEqual(
      database
        .query<{
          cleanup_problem_count: number;
          estimated_cost_usd_cents: number;
          fallback_count: number;
          maximum_duration_ms: number;
          summary_month: string;
          total_duration_ms: number;
          usage_count: number;
        }>(`
          SELECT
            summary_month,
            sum(usage_count) AS usage_count,
            sum(total_duration_ms) AS total_duration_ms,
            max(maximum_duration_ms) AS maximum_duration_ms,
            sum(estimated_cost_usd_cents) AS estimated_cost_usd_cents,
            sum(fallback_count) AS fallback_count,
            sum(cleanup_problem_count) AS cleanup_problem_count
          FROM monthly_summaries
          GROUP BY summary_month
          ORDER BY summary_month
        `)
        .map((summary) => ({
          summary_month: summary.summary_month,
          usage_count: summary.usage_count,
          total_duration_ms: summary.total_duration_ms,
          maximum_duration_ms: summary.maximum_duration_ms,
          estimated_cost_usd_cents: summary.estimated_cost_usd_cents,
          fallback_count: summary.fallback_count,
          cleanup_problem_count: summary.cleanup_problem_count,
        })),
      [
        {
          summary_month: "2025-08",
          usage_count: 2,
          total_duration_ms: 180_000,
          maximum_duration_ms: 120_000,
          estimated_cost_usd_cents: 30,
          fallback_count: 1,
          cleanup_problem_count: 1,
        },
      ],
    );

    assert.deepEqual(await store.runRetention(NOW), []);
    assert.deepEqual(
      database.query("SELECT * FROM daily_summaries ORDER BY summary_date"),
      summaries,
    );
    assert.equal(await store.writeUsageRecord("allocation:old-azure", oldAzure), "replayed");
    assert.equal(database.query("SELECT * FROM usage_records").length, 1);
    assert.equal(
      await store.writeUsageRecord("allocation:old-azure", {
        ...oldAzure,
        estimated_cost_usd_cents: 99,
      }),
      "conflict",
    );

    await store.writeUsageRecord(
      "allocation:late-old-azure",
      usageRecordEndingAt("2025-08-23T12:00:00.000Z", 30_000, {
        github_run_id: "13",
        estimated_cost_usd_cents: 5,
      }),
    );
    assert.deepEqual(await store.runRetention(NOW), ["2025-08-23"]);
    assert.deepEqual(
      database
        .query<{
          estimated_cost_usd_cents: number;
          maximum_duration_ms: number;
          total_duration_ms: number;
          usage_count: number;
        }>(`
          SELECT usage_count, total_duration_ms, maximum_duration_ms, estimated_cost_usd_cents
          FROM daily_summaries
          WHERE summary_date = '2025-08-23' AND provider = 'azure' AND outcome = 'success'
        `)
        .map((summary) => ({
          usage_count: summary.usage_count,
          total_duration_ms: summary.total_duration_ms,
          maximum_duration_ms: summary.maximum_duration_ms,
          estimated_cost_usd_cents: summary.estimated_cost_usd_cents,
        })),
      [
        {
          usage_count: 2,
          total_duration_ms: 90_000,
          maximum_duration_ms: 60_000,
          estimated_cost_usd_cents: 15,
        },
      ],
    );
  });

  it("rolls back summary, retirement marker and deletion together", async () => {
    await store.writeUsageRecord(
      "allocation:old",
      usageRecordEndingAt("2025-08-24T12:00:00.000Z", 60_000),
    );
    database.failNextBatchAt(2);

    await assert.rejects(() => store.runRetention(NOW), /simulated D1 batch failure/);
    assert.equal(database.query("SELECT * FROM daily_summaries").length, 0);
    assert.equal(database.query("SELECT * FROM usage_records").length, 1);
    assert.equal(
      database.query<{ detail_retired: number }>(
        "SELECT detail_retired FROM usage_record_idempotency",
      )[0]?.detail_retired,
      0,
    );

    assert.deepEqual(await store.runRetention(NOW), ["2025-08-24"]);
  });
});

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
    started_at: "2026-08-24T10:00:00.000Z",
    completed_at: "2026-08-24T10:05:00.000Z",
    duration_ms: 300_000,
    outcome: "success",
    fallback_used: false,
    cleanup_problem: false,
    estimated_cost_usd_cents: 42,
    ...overrides,
  });
}

function usageRecordEndingAt(
  completedAt: string,
  durationMilliseconds: number,
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
  return usageRecord({
    completed_at: completedAt,
    started_at: new Date(Date.parse(completedAt) - durationMilliseconds).toISOString(),
    duration_ms: durationMilliseconds,
    ...overrides,
  });
}
