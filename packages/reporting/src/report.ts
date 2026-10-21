import {
  parseUsageRecord,
  type CapabilityProfile,
  type ProviderName,
  type UsageOutcome,
  type UsageRecord,
} from "./usage-record.js";

export const REPORT_WINDOWS = [7, 30, 365] as const;
export const SLOW_JOB_LIMIT = 10;

export type ReportWindowDays = (typeof REPORT_WINDOWS)[number];

export interface UsageBreakdown<T extends string> {
  readonly count: number;
  readonly estimated_cost_usd_cents: number;
  readonly key: T;
  readonly total_duration_ms: number;
}

export interface TimeSummary {
  readonly cleanup_problem_count: number;
  readonly estimated_cost_usd_cents: number;
  readonly fallback_count: number;
  readonly maximum_duration_ms: number;
  readonly total_duration_ms: number;
  readonly usage_count: number;
}

export interface DailyUsageSummary extends TimeSummary {
  readonly date: string;
}

export interface MonthlyUsageSummary extends TimeSummary {
  readonly month: string;
}

export interface ReportJobReference {
  readonly duration_ms: number;
  readonly github_run_id: string;
  readonly github_run_url: string;
  readonly job: string;
  readonly repository: string;
  readonly workflow: string;
}

export interface UsageReport {
  readonly cleanup_problems: {
    readonly count: number;
    readonly jobs: readonly ReportJobReference[];
  };
  readonly cost: {
    readonly estimated_usd_cents: number;
  };
  readonly daily: readonly DailyUsageSummary[];
  readonly fallback: {
    readonly count: number;
  };
  readonly generated_at: string;
  readonly monthly: readonly MonthlyUsageSummary[];
  readonly slow_jobs: readonly ReportJobReference[];
  readonly usage: {
    readonly average_duration_ms: number;
    readonly by_outcome: readonly UsageBreakdown<UsageOutcome>[];
    readonly by_profile: readonly UsageBreakdown<CapabilityProfile>[];
    readonly by_provider: readonly UsageBreakdown<ProviderName>[];
    readonly total_allocations: number;
    readonly total_duration_ms: number;
  };
  readonly window: {
    readonly from_inclusive: string;
    readonly to_exclusive: string;
  };
  readonly window_days: ReportWindowDays;
}

export interface WeeklyReportPayload {
  readonly generated_at: string;
  readonly kind: "switchyard-weekly-report-v1";
  readonly report: UsageReport;
  readonly summary_markdown: string;
}

export function parseReportWindowDays(value: unknown): ReportWindowDays {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof numeric !== "number" || !REPORT_WINDOWS.some((windowDays) => windowDays === numeric)) {
    throw new TypeError("report window must be exactly 7, 30 or 365 days");
  }
  return numeric as ReportWindowDays;
}

export function reportWindow(
  windowDays: ReportWindowDays,
  generatedAt: Date,
): UsageReport["window"] {
  const validatedDays = parseReportWindowDays(windowDays);
  const generatedMilliseconds = generatedAt.getTime();
  if (!Number.isFinite(generatedMilliseconds)) {
    throw new TypeError("report generation time must be valid");
  }

  return {
    from_inclusive: new Date(
      generatedMilliseconds - validatedDays * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    to_exclusive: generatedAt.toISOString(),
  };
}

export function buildUsageReport(
  values: readonly unknown[],
  windowDays: ReportWindowDays,
  generatedAt: Date,
): UsageReport {
  const window = reportWindow(windowDays, generatedAt);
  const records = values
    .map((value) => parseUsageRecord(value))
    .filter(
      (record) =>
        record.completed_at >= window.from_inclusive && record.completed_at < window.to_exclusive,
    );

  const totalDuration = sum(records, (record) => record.duration_ms);
  const totalCost = sum(records, (record) => record.estimated_cost_usd_cents);
  const slowJobs = [...records]
    .sort(
      (left, right) =>
        right.duration_ms - left.duration_ms ||
        left.completed_at.localeCompare(right.completed_at) ||
        left.github_run_id.localeCompare(right.github_run_id),
    )
    .slice(0, SLOW_JOB_LIMIT)
    .map(toJobReference);
  const cleanupRecords = records.filter((record) => record.cleanup_problem);
  const daily = buildTimeSummaries(records, (record) => record.completed_at.slice(0, 10)).map(
    ([date, summary]) => ({ date, ...summary }),
  );

  return {
    window_days: windowDays,
    generated_at: generatedAt.toISOString(),
    window,
    usage: {
      total_allocations: records.length,
      total_duration_ms: totalDuration,
      average_duration_ms: records.length === 0 ? 0 : Math.round(totalDuration / records.length),
      by_provider: breakdown(records, (record) => record.provider),
      by_profile: breakdown(records, (record) => record.capability_profile),
      by_outcome: breakdown(records, (record) => record.outcome),
    },
    cost: { estimated_usd_cents: totalCost },
    slow_jobs: slowJobs,
    fallback: { count: records.filter((record) => record.fallback_used).length },
    cleanup_problems: {
      count: cleanupRecords.length,
      jobs: cleanupRecords.map(toJobReference),
    },
    daily,
    monthly: deriveMonthlySummaries(daily),
  };
}

export function deriveMonthlySummaries(
  dailySummaries: readonly DailyUsageSummary[],
): readonly MonthlyUsageSummary[] {
  const grouped = new Map<string, TimeSummary>();
  for (const daily of dailySummaries) {
    const month = daily.date.slice(0, 7);
    const previous = grouped.get(month) ?? emptyTimeSummary();
    grouped.set(month, {
      usage_count: previous.usage_count + daily.usage_count,
      total_duration_ms: previous.total_duration_ms + daily.total_duration_ms,
      maximum_duration_ms: Math.max(previous.maximum_duration_ms, daily.maximum_duration_ms),
      estimated_cost_usd_cents: previous.estimated_cost_usd_cents + daily.estimated_cost_usd_cents,
      fallback_count: previous.fallback_count + daily.fallback_count,
      cleanup_problem_count: previous.cleanup_problem_count + daily.cleanup_problem_count,
    });
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, summary]) => ({ month, ...summary }));
}

export function createWeeklyReportPayload(report: UsageReport): WeeklyReportPayload {
  if (report.window_days !== 7) {
    throw new TypeError("a weekly payload requires the fixed 7 day report");
  }

  const generatedAt = new Date(report.generated_at);
  if (
    generatedAt.getUTCDay() !== 1 ||
    generatedAt.getUTCHours() !== 8 ||
    generatedAt.getUTCMinutes() !== 0 ||
    generatedAt.getUTCSeconds() !== 0 ||
    generatedAt.getUTCMilliseconds() !== 0
  ) {
    throw new TypeError("a weekly payload must be generated at Monday 08:00 UTC");
  }

  return {
    kind: "switchyard-weekly-report-v1",
    generated_at: report.generated_at,
    report,
    summary_markdown: formatUsageReportMarkdown(report),
  };
}

export function formatUsageReportMarkdown(report: UsageReport): string {
  const lines = [
    `# Switchyard ${report.window_days} day report`,
    "",
    `Window: ${report.window.from_inclusive} to ${report.window.to_exclusive} (UTC, end excluded)`,
    "",
    `- Usage: ${report.usage.total_allocations} allocations`,
    `- Estimated cost: ${formatUsdCents(report.cost.estimated_usd_cents)}`,
    `- Average duration: ${formatDuration(report.usage.average_duration_ms)}`,
    `- Fallbacks: ${report.fallback.count}`,
    `- Cleanup problems: ${report.cleanup_problems.count}`,
    "",
    "## Provider usage",
    "",
    "| Provider | Allocations | Duration | Estimated cost |",
    "| --- | ---: | ---: | ---: |",
    ...report.usage.by_provider.map(
      (entry) =>
        `| ${escapeMarkdown(entry.key)} | ${entry.count} | ${formatDuration(entry.total_duration_ms)} | ${formatUsdCents(entry.estimated_cost_usd_cents)} |`,
    ),
    "",
    "## Slow jobs",
    "",
  ];

  if (report.slow_jobs.length === 0) {
    lines.push("No jobs in this window.");
  } else {
    lines.push(
      "| Repository | Workflow | Job | Duration | Run |",
      "| --- | --- | --- | ---: | --- |",
      ...report.slow_jobs.map(
        (job) =>
          `| ${escapeMarkdown(job.repository)} | ${escapeMarkdown(job.workflow)} | ${escapeMarkdown(job.job)} | ${formatDuration(job.duration_ms)} | [${job.github_run_id}](${job.github_run_url}) |`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

function breakdown<T extends string>(
  records: readonly UsageRecord[],
  keyFor: (record: UsageRecord) => T,
): readonly UsageBreakdown<T>[] {
  const grouped = new Map<T, UsageRecord[]>();
  for (const record of records) {
    const key = keyFor(record);
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({
      key,
      count: group.length,
      total_duration_ms: sum(group, (record) => record.duration_ms),
      estimated_cost_usd_cents: sum(group, (record) => record.estimated_cost_usd_cents),
    }));
}

function buildTimeSummaries(
  records: readonly UsageRecord[],
  keyFor: (record: UsageRecord) => string,
): readonly [string, TimeSummary][] {
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = keyFor(record);
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => [
      key,
      {
        usage_count: group.length,
        total_duration_ms: sum(group, (record) => record.duration_ms),
        maximum_duration_ms: Math.max(...group.map((record) => record.duration_ms)),
        estimated_cost_usd_cents: sum(group, (record) => record.estimated_cost_usd_cents),
        fallback_count: group.filter((record) => record.fallback_used).length,
        cleanup_problem_count: group.filter((record) => record.cleanup_problem).length,
      },
    ]);
}

function emptyTimeSummary(): TimeSummary {
  return {
    usage_count: 0,
    total_duration_ms: 0,
    maximum_duration_ms: 0,
    estimated_cost_usd_cents: 0,
    fallback_count: 0,
    cleanup_problem_count: 0,
  };
}

function toJobReference(record: UsageRecord): ReportJobReference {
  return {
    repository: record.repository,
    workflow: record.workflow,
    job: record.job,
    github_run_id: record.github_run_id,
    github_run_url: record.github_run_url,
    duration_ms: record.duration_ms,
  };
}

function sum(records: readonly UsageRecord[], valueFor: (record: UsageRecord) => number): number {
  return records.reduce((total, record) => total + valueFor(record), 0);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|");
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
