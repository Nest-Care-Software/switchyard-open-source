import { parseUsageRecord, type UsageRecord } from "../src/index.js";

export function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  const githubRunId = overrides.github_run_id ?? "1234567890";
  const repository = overrides.repository ?? "example-org/example-workload";
  return parseUsageRecord({
    repository,
    workflow: ".github/workflows/ci.yml",
    job: "example-build",
    github_run_id: githubRunId,
    github_run_url:
      overrides.github_run_url ?? `https://github.com/${repository}/actions/runs/${githubRunId}`,
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

export function usageRecordEndingAt(
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
