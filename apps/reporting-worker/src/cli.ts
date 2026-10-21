import process from "node:process";

import {
  formatUsageReportMarkdown,
  parseReportWindowDays,
  type ReportWindowDays,
  type UsageReport,
} from "@switchyard/reporting";

export interface ReportCliOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly format: "json" | "markdown";
  readonly windowDays: ReportWindowDays;
}

export function parseReportCliOptions(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ReportCliOptions {
  let daysValue: string | undefined;
  let format: ReportCliOptions["format"] = "markdown";
  let baseUrl = environment.SWITCHYARD_REPORTING_URL;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const next = arguments_[index + 1];
    if (argument === "--days" && next !== undefined) {
      daysValue = next;
      index += 1;
    } else if (argument === "--format" && (next === "json" || next === "markdown")) {
      format = next;
      index += 1;
    } else if (argument === "--base-url" && next !== undefined) {
      baseUrl = next;
      index += 1;
    } else {
      throw new TypeError(`unsupported or incomplete argument '${argument ?? ""}'`);
    }
  }

  if (daysValue === undefined) {
    throw new TypeError("--days is required and must be 7, 30 or 365");
  }
  return {
    windowDays: parseReportWindowDays(daysValue),
    format,
    baseUrl: requireRuntimeValue(baseUrl, "SWITCHYARD_REPORTING_URL or --base-url"),
    clientId: requireRuntimeValue(
      environment.SWITCHYARD_REPORTING_ACCESS_CLIENT_ID,
      "SWITCHYARD_REPORTING_ACCESS_CLIENT_ID",
    ),
    clientSecret: requireRuntimeValue(
      environment.SWITCHYARD_REPORTING_ACCESS_CLIENT_SECRET,
      "SWITCHYARD_REPORTING_ACCESS_CLIENT_SECRET",
    ),
  };
}

export async function queryReport(
  options: ReportCliOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<UsageReport> {
  const endpoint = reportEndpoint(options.baseUrl, options.windowDays);
  const response = await fetchImplementation(endpoint, {
    headers: {
      Accept: "application/json",
      "CF-Access-Client-Id": options.clientId,
      "CF-Access-Client-Secret": options.clientSecret,
    },
  });
  if (!response.ok) {
    throw new Error(`report query returned HTTP ${response.status}`);
  }
  return (await response.json()) as UsageReport;
}

export function formatReportForCli(report: UsageReport, format: "json" | "markdown"): string {
  return format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatUsageReportMarkdown(report);
}

async function main(): Promise<void> {
  const options = parseReportCliOptions(process.argv.slice(2), process.env);
  const report = await queryReport(options);
  process.stdout.write(formatReportForCli(report, options.format));
}

function reportEndpoint(baseUrl: string, windowDays: ReportWindowDays): URL {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("reporting base URL must be HTTPS without credentials or a query");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/reports/${windowDays}`;
  return url;
}

function requireRuntimeValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required at runtime`);
  }
  return value;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href;
if (invokedAsScript) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "report query failed"}\n`);
    process.exitCode = 1;
  });
}
