import {
  CAPABILITY_PROFILES,
  PROVIDER_NAMES,
  type CapabilityProfile,
  type ProviderName,
} from "@switchyard/core";

export { CAPABILITY_PROFILES, PROVIDER_NAMES };
export type { CapabilityProfile, ProviderName };

export class UsageRecordValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "UsageRecordValidationError";
    this.path = path;
  }
}

export const USAGE_OUTCOMES = [
  "success",
  "failure",
  "cancelled",
  "timed-out",
  "abandoned",
] as const;

export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

export interface UsageRecord {
  readonly capability_profile: CapabilityProfile;
  readonly cleanup_problem: boolean;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly estimated_cost_usd_cents: number;
  readonly fallback_used: boolean;
  readonly github_run_id: string;
  readonly github_run_url: string;
  readonly job: string;
  readonly outcome: UsageOutcome;
  readonly provider: ProviderName;
  readonly repository: string;
  readonly started_at: string;
  readonly workflow: string;
}

export interface ApprovedReportingDimensions {
  readonly repository: string;
  readonly workflow: string;
  readonly job: string;
}

export interface UsageRecordContract {
  readonly approvedDimensions: readonly ApprovedReportingDimensions[];
  canonicalJson(record: UsageRecord): string;
  parse(value: unknown): UsageRecord;
}

export const V1_APPROVED_REPORTING_DIMENSIONS = Object.freeze([
  Object.freeze({
    repository: "example-org/example-workload",
    workflow: ".github/workflows/ci.yml",
    job: "example-build",
  }),
] satisfies readonly ApprovedReportingDimensions[]);

export const USAGE_RECORD_KEYS = [
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
] as const;

const MAXIMUM_DIMENSION_LENGTHS = {
  repository: 100,
  workflow: 256,
  job: 256,
} as const;

export const V1_USAGE_RECORD_CONTRACT = createUsageRecordContract(V1_APPROVED_REPORTING_DIMENSIONS);

export function createUsageRecordContract(
  approvedDimensions: readonly ApprovedReportingDimensions[],
): UsageRecordContract {
  const immutableDimensions = copyAndValidateApprovedDimensions(approvedDimensions);

  return Object.freeze({
    approvedDimensions: immutableDimensions,
    parse(value: unknown): UsageRecord {
      return parseUsageRecordAgainstDimensions(value, immutableDimensions);
    },
    canonicalJson(record: UsageRecord): string {
      const validated = parseUsageRecordAgainstDimensions(record, immutableDimensions);
      return JSON.stringify(
        Object.fromEntries(USAGE_RECORD_KEYS.map((key) => [key, validated[key]])),
      );
    },
  });
}

export function parseUsageRecord(value: unknown): UsageRecord {
  return V1_USAGE_RECORD_CONTRACT.parse(value);
}

export function canonicalUsageRecordJson(record: UsageRecord): string {
  return V1_USAGE_RECORD_CONTRACT.canonicalJson(record);
}

function parseUsageRecordAgainstDimensions(
  value: unknown,
  approvedDimensions: readonly ApprovedReportingDimensions[],
): UsageRecord {
  const record = requireRecord(value, "usageRecord");
  requireExactKeys(record, USAGE_RECORD_KEYS, "usageRecord");
  requireAllKeys(record);

  const repository = requireBoundedString(
    record.repository,
    "usageRecord.repository",
    MAXIMUM_DIMENSION_LENGTHS.repository,
  );
  const workflow = requireBoundedString(
    record.workflow,
    "usageRecord.workflow",
    MAXIMUM_DIMENSION_LENGTHS.workflow,
  );
  const job = requireBoundedString(record.job, "usageRecord.job", MAXIMUM_DIMENSION_LENGTHS.job);
  requireApprovedReportingDimensions({ repository, workflow, job }, approvedDimensions);
  const github_run_id = requirePositiveDecimalString(
    record.github_run_id,
    "usageRecord.github_run_id",
  );
  const github_run_url = requireGitHubRunUrl(record.github_run_url, github_run_id, repository);
  const provider = requireMember(record.provider, PROVIDER_NAMES, "usageRecord.provider");
  const capability_profile = requireMember(
    record.capability_profile,
    CAPABILITY_PROFILES,
    "usageRecord.capability_profile",
  );
  const started_at = requireCanonicalUtcTimestamp(record.started_at, "usageRecord.started_at");
  const completed_at = requireCanonicalUtcTimestamp(
    record.completed_at,
    "usageRecord.completed_at",
  );
  const duration_ms = requireNonNegativeSafeInteger(record.duration_ms, "usageRecord.duration_ms");
  const outcome = requireMember(record.outcome, USAGE_OUTCOMES, "usageRecord.outcome");
  const fallback_used = requireBoolean(record.fallback_used, "usageRecord.fallback_used");
  const cleanup_problem = requireBoolean(record.cleanup_problem, "usageRecord.cleanup_problem");
  const estimated_cost_usd_cents = requireNonNegativeSafeInteger(
    record.estimated_cost_usd_cents,
    "usageRecord.estimated_cost_usd_cents",
  );

  const measuredDuration = Date.parse(completed_at) - Date.parse(started_at);
  if (measuredDuration < 0) {
    throw new UsageRecordValidationError(
      "usageRecord.completed_at",
      "must not be earlier than started_at",
    );
  }
  if (duration_ms !== measuredDuration) {
    throw new UsageRecordValidationError(
      "usageRecord.duration_ms",
      "must exactly equal completed_at minus started_at",
    );
  }

  if (fallback_used !== (provider === "blacksmith")) {
    throw new UsageRecordValidationError(
      "usageRecord.fallback_used",
      "must be true exactly when the V1 provider is blacksmith",
    );
  }

  return {
    repository,
    workflow,
    job,
    github_run_id,
    github_run_url,
    provider,
    capability_profile,
    started_at,
    completed_at,
    duration_ms,
    outcome,
    fallback_used,
    cleanup_problem,
    estimated_cost_usd_cents,
  };
}

function requireAllKeys(record: Record<string, unknown>): void {
  for (const key of USAGE_RECORD_KEYS) {
    if (!Object.hasOwn(record, key)) {
      throw new UsageRecordValidationError(`usageRecord.${key}`, "is required");
    }
  }
}

function requireBoundedString(value: unknown, path: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new UsageRecordValidationError(
      path,
      `must be a string of 1 to ${maximumLength} characters`,
    );
  }

  return value;
}

function requireApprovedReportingDimensions(
  dimensions: ApprovedReportingDimensions,
  approvedDimensions: readonly ApprovedReportingDimensions[],
): void {
  const approved = approvedDimensions.some(
    (candidate) =>
      candidate.repository === dimensions.repository &&
      candidate.workflow === dimensions.workflow &&
      candidate.job === dimensions.job,
  );
  if (!approved) {
    throw new UsageRecordValidationError(
      "usageRecord.reporting_dimensions",
      "repository, workflow and job must exactly match one centrally approved combination",
    );
  }
}

function copyAndValidateApprovedDimensions(
  approvedDimensions: readonly ApprovedReportingDimensions[],
): readonly ApprovedReportingDimensions[] {
  if (!Array.isArray(approvedDimensions) || approvedDimensions.length === 0) {
    throw new TypeError("approved reporting dimensions must contain at least one combination");
  }

  const unique = new Set<string>();
  const copied = approvedDimensions.map((value, index) => {
    const record = requireRecord(value, `approvedDimensions[${index}]`);
    requireExactKeys(
      record,
      ["repository", "workflow", "job"] as const,
      `approvedDimensions[${index}]`,
    );
    const repository = requireCentralRepository(
      record.repository,
      `approvedDimensions[${index}].repository`,
    );
    const workflow = requireCentralWorkflow(
      record.workflow,
      `approvedDimensions[${index}].workflow`,
    );
    const job = requireCentralJob(record.job, `approvedDimensions[${index}].job`);
    const identity = JSON.stringify([repository, workflow, job]);
    if (unique.has(identity)) {
      throw new TypeError(`approvedDimensions[${index}] duplicates an earlier combination`);
    }
    unique.add(identity);
    return Object.freeze({ repository, workflow, job });
  });

  return Object.freeze(copied);
}

function requireCentralRepository(value: unknown, path: string): string {
  const repository = requireBoundedString(value, path, MAXIMUM_DIMENSION_LENGTHS.repository);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repository)) {
    throw new TypeError(`${path} must be a full GitHub owner/repository slug`);
  }
  return repository;
}

function requireCentralWorkflow(value: unknown, path: string): string {
  const workflow = requireBoundedString(value, path, MAXIMUM_DIMENSION_LENGTHS.workflow);
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(workflow)) {
    throw new TypeError(`${path} must be a checked-in GitHub workflow path`);
  }
  return workflow;
}

function requireCentralJob(value: unknown, path: string): string {
  const job = requireBoundedString(value, path, MAXIMUM_DIMENSION_LENGTHS.job);
  if (!/^[A-Za-z0-9_-]+$/.test(job)) {
    throw new TypeError(`${path} must be a GitHub job identifier`);
  }
  return job;
}

function requirePositiveDecimalString(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new UsageRecordValidationError(path, "must be a positive decimal string");
  }
  return value;
}

function requireGitHubRunUrl(value: unknown, runId: string, repository: string): string {
  if (typeof value !== "string" || value.length > 512) {
    throw new UsageRecordValidationError(
      "usageRecord.github_run_url",
      "must be a bounded GitHub Actions run URL",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageRecordValidationError("usageRecord.github_run_url", "must be a valid HTTPS URL");
  }

  const [repositoryOwner, repositoryName] = repository.split("/");
  const segments = url.pathname.split("/").filter(Boolean);
  const validPath =
    (segments.length === 5 || segments.length === 7) &&
    segments[0] === repositoryOwner &&
    segments[1] === repositoryName &&
    segments[2] === "actions" &&
    segments[3] === "runs" &&
    segments[4] === runId &&
    (segments.length === 5 || (segments[5] === "attempts" && /^[1-9]\d*$/.test(segments[6] ?? "")));

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !validPath
  ) {
    throw new UsageRecordValidationError(
      "usageRecord.github_run_url",
      "must identify the matching github.com repository and run",
    );
  }

  return url.toString();
}

function requireCanonicalUtcTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new UsageRecordValidationError(
      path,
      "must be a canonical UTC timestamp with milliseconds",
    );
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new UsageRecordValidationError(path, "must be a real canonical UTC timestamp");
  }

  return value;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UsageRecordValidationError(path, "must be a non-negative safe integer");
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new UsageRecordValidationError(path, "must be a boolean");
  }
  return value;
}

function requireMember<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new UsageRecordValidationError(
      path,
      `must be one of ${allowed.map((entry) => `'${entry}'`).join(", ")}`,
    );
  }
  return value as T[number];
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageRecordValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new UsageRecordValidationError(path, `contains unsupported field '${unknownKeys[0]}'`);
  }
}
