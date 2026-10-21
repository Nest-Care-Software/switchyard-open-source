import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildUsageReport } from "@switchyard/reporting";

import { formatReportForCli, parseReportCliOptions, queryReport } from "../src/cli.js";

describe("private reporting CLI", () => {
  it("reads its endpoint and Access service credentials only from arguments and runtime environment", () => {
    assert.deepEqual(
      parseReportCliOptions(["--days", "30", "--format", "json"], {
        SWITCHYARD_REPORTING_URL: "https://reporting.example.test",
        SWITCHYARD_REPORTING_ACCESS_CLIENT_ID: "runtime-id",
        SWITCHYARD_REPORTING_ACCESS_CLIENT_SECRET: "runtime-secret",
      }),
      {
        windowDays: 30,
        format: "json",
        baseUrl: "https://reporting.example.test",
        clientId: "runtime-id",
        clientSecret: "runtime-secret",
      },
    );

    assert.throws(() => parseReportCliOptions(["--days", "7"], {}));
    assert.throws(() =>
      parseReportCliOptions(["--days", "14"], {
        SWITCHYARD_REPORTING_URL: "https://reporting.example.test",
        SWITCHYARD_REPORTING_ACCESS_CLIENT_ID: "runtime-id",
        SWITCHYARD_REPORTING_ACCESS_CLIENT_SECRET: "runtime-secret",
      }),
    );
  });

  it("queries only the selected fixed report and supplies Access headers", async () => {
    const report = buildUsageReport([], 7, new Date("2026-08-24T08:00:00.000Z"));
    let captured: Request | undefined;
    const result = await queryReport(
      {
        windowDays: 7,
        format: "markdown",
        baseUrl: "https://reporting.example.test",
        clientId: "runtime-id",
        clientSecret: "runtime-secret",
      },
      async (input, init) => {
        captured = new Request(input, init);
        return Response.json(report);
      },
    );

    assert.deepEqual(result, report);
    assert.equal(captured?.url, "https://reporting.example.test/v1/reports/7");
    assert.equal(captured?.headers.get("CF-Access-Client-Id"), "runtime-id");
    assert.equal(captured?.headers.get("CF-Access-Client-Secret"), "runtime-secret");
  });

  it("formats JSON or GitHub workflow-summary Markdown", () => {
    const report = buildUsageReport([], 7, new Date("2026-08-24T08:00:00.000Z"));
    assert.deepEqual(JSON.parse(formatReportForCli(report, "json")), report);
    assert.match(formatReportForCli(report, "markdown"), /# Switchyard 7 day report/);
  });
});
