import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildUsageReport,
  createWeeklyReportPayload,
  deriveMonthlySummaries,
  formatUsageReportMarkdown,
  parseReportWindowDays,
  reportWindow,
} from "../src/index.js";
import { usageRecordEndingAt } from "./fixture.js";

describe("fixed reporting operations", () => {
  it("accepts only exact 7, 30 and 365 day windows", () => {
    for (const value of [7, "7", 30, "30", 365, "365"]) {
      assert.equal(parseReportWindowDays(value), Number(value));
    }
    for (const value of [0, 1, 14, 366, "7 days", undefined, null]) {
      assert.throws(() => parseReportWindowDays(value));
    }
  });

  it("uses an exact rolling UTC window with an inclusive start and exclusive end", () => {
    const generatedAt = new Date("2026-09-02T00:00:00.000Z");
    assert.deepEqual(reportWindow(7, generatedAt), {
      from_inclusive: "2026-08-26T00:00:00.000Z",
      to_exclusive: "2026-09-02T00:00:00.000Z",
    });

    const report = buildUsageReport(
      [
        usageRecordEndingAt("2026-08-25T23:59:59.999Z", 1, { github_run_id: "1" }),
        usageRecordEndingAt("2026-08-26T00:00:00.000Z", 1, { github_run_id: "2" }),
        usageRecordEndingAt("2026-09-01T23:59:59.999Z", 1, { github_run_id: "3" }),
        usageRecordEndingAt("2026-09-02T00:00:00.000Z", 1, { github_run_id: "4" }),
      ],
      7,
      generatedAt,
    );

    assert.equal(report.usage.total_allocations, 2);
    assert.deepEqual(
      report.slow_jobs.map((job) => job.github_run_id),
      ["2", "3"],
    );
  });

  it("reports usage, cost, slow jobs, fallback and cleanup problems", () => {
    const report = buildUsageReport(
      [
        usageRecordEndingAt("2026-08-24T07:00:00.000Z", 60_000, {
          github_run_id: "10",
          estimated_cost_usd_cents: 10,
        }),
        usageRecordEndingAt("2026-08-24T07:30:00.000Z", 600_000, {
          github_run_id: "11",
          provider: "blacksmith",
          fallback_used: true,
          cleanup_problem: true,
          outcome: "failure",
          estimated_cost_usd_cents: 25,
        }),
      ],
      7,
      new Date("2026-08-24T08:00:00.000Z"),
    );

    assert.equal(report.usage.total_allocations, 2);
    assert.equal(report.usage.total_duration_ms, 660_000);
    assert.equal(report.usage.average_duration_ms, 330_000);
    assert.equal(report.cost.estimated_usd_cents, 35);
    assert.deepEqual(
      report.slow_jobs.map((job) => job.github_run_id),
      ["11", "10"],
    );
    assert.equal(report.fallback.count, 1);
    assert.equal(report.cleanup_problems.count, 1);
    assert.equal(report.cleanup_problems.jobs[0]?.github_run_id, "11");
    assert.deepEqual(report.usage.by_provider, [
      { key: "azure", count: 1, total_duration_ms: 60_000, estimated_cost_usd_cents: 10 },
      {
        key: "blacksmith",
        count: 1,
        total_duration_ms: 600_000,
        estimated_cost_usd_cents: 25,
      },
    ]);
  });

  it("groups UTC days and derives monthly summaries from them", () => {
    const report = buildUsageReport(
      [
        usageRecordEndingAt("2026-08-31T23:59:59.999Z", 100, { github_run_id: "20" }),
        usageRecordEndingAt("2026-09-01T00:00:00.000Z", 200, {
          github_run_id: "21",
          cleanup_problem: true,
        }),
      ],
      7,
      new Date("2026-09-02T00:00:00.000Z"),
    );

    assert.deepEqual(
      report.daily.map((entry) => entry.date),
      ["2026-08-31", "2026-09-01"],
    );
    assert.deepEqual(
      report.monthly.map((entry) => entry.month),
      ["2026-08", "2026-09"],
    );
    assert.equal(report.monthly[1]?.cleanup_problem_count, 1);
    assert.deepEqual(deriveMonthlySummaries(report.daily), report.monthly);
  });

  it("generates the Monday 08:00 UTC weekly payload and workflow-summary Markdown", () => {
    const report = buildUsageReport([], 7, new Date("2026-08-24T08:00:00.000Z"));
    const payload = createWeeklyReportPayload(report);

    assert.equal(payload.kind, "switchyard-weekly-report-v1");
    assert.equal(payload.generated_at, "2026-08-24T08:00:00.000Z");
    assert.match(payload.summary_markdown, /# Switchyard 7 day report/);
    assert.doesNotMatch(payload.summary_markdown, /—/);
    assert.equal(payload.summary_markdown, formatUsageReportMarkdown(report));

    assert.throws(() =>
      createWeeklyReportPayload(buildUsageReport([], 7, new Date("2026-08-24T08:01:00.000Z"))),
    );
    assert.throws(() =>
      createWeeklyReportPayload(buildUsageReport([], 30, new Date("2026-08-24T08:00:00.000Z"))),
    );
  });
});
