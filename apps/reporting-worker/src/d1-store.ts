import {
  buildUsageReport,
  canonicalUsageRecordJson,
  parseUsageRecord,
  reportWindow,
  type ReportWindowDays,
  type UsageRecord,
  type UsageReport,
} from "@switchyard/reporting";

export interface D1ResultLike<T = Record<string, unknown>> {
  readonly results: readonly T[];
  readonly success: boolean;
}

export interface D1PreparedStatementLike {
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  batch<T = Record<string, unknown>>(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly D1ResultLike<T>[]>;
  prepare(sql: string): D1PreparedStatementLike;
}

export type UsageWriteOutcome = "created" | "replayed" | "conflict";

interface StoredHashRow {
  readonly payload_hash: string;
}

interface StoredUsageRow {
  readonly capability_profile: string;
  readonly cleanup_problem: number;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly estimated_cost_usd_cents: number;
  readonly fallback_used: number;
  readonly github_run_id: string;
  readonly github_run_url: string;
  readonly job: string;
  readonly outcome: string;
  readonly provider: string;
  readonly repository: string;
  readonly started_at: string;
  readonly workflow: string;
}

interface SummaryDateRow {
  readonly summary_date: string;
}

const INSERT_USAGE_SQL = `
INSERT INTO usage_records (
  idempotency_key_hash,
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
  estimated_cost_usd_cents
)
SELECT ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
WHERE EXISTS (
  SELECT 1
  FROM usage_record_idempotency
  WHERE idempotency_key_hash = ?1 AND payload_hash = ?2 AND detail_retired = 0
)
ON CONFLICT (idempotency_key_hash) DO NOTHING
RETURNING idempotency_key_hash`;

const INSERT_IDEMPOTENCY_SQL = `
INSERT INTO usage_record_idempotency (idempotency_key_hash, payload_hash)
VALUES (?1, ?2)
ON CONFLICT (idempotency_key_hash) DO NOTHING
RETURNING payload_hash`;

const SELECT_USAGE_HASH_SQL = `
SELECT payload_hash
FROM usage_record_idempotency
WHERE idempotency_key_hash = ?1`;

const SELECT_REPORT_DETAIL_SQL = `
SELECT
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
  estimated_cost_usd_cents
FROM usage_records
WHERE completed_at >= ?1 AND completed_at < ?2
ORDER BY completed_at ASC, idempotency_key_hash ASC`;

const SELECT_EXPIRED_DATES_SQL = `
SELECT DISTINCT substr(completed_at, 1, 10) AS summary_date
FROM usage_records
WHERE completed_at < ?1
ORDER BY summary_date ASC`;

const UPSERT_DAILY_SUMMARY_SQL = `
INSERT INTO daily_summaries (
  summary_date,
  provider,
  capability_profile,
  outcome,
  usage_count,
  total_duration_ms,
  maximum_duration_ms,
  estimated_cost_usd_cents,
  fallback_count,
  cleanup_problem_count
)
SELECT
  substr(completed_at, 1, 10),
  provider,
  capability_profile,
  outcome,
  count(*),
  sum(duration_ms),
  max(duration_ms),
  sum(estimated_cost_usd_cents),
  sum(fallback_used),
  sum(cleanup_problem)
FROM usage_records
WHERE completed_at >= ?1 AND completed_at < ?2
GROUP BY substr(completed_at, 1, 10), provider, capability_profile, outcome
ON CONFLICT (summary_date, provider, capability_profile, outcome) DO UPDATE SET
  usage_count = daily_summaries.usage_count + excluded.usage_count,
  total_duration_ms = daily_summaries.total_duration_ms + excluded.total_duration_ms,
  maximum_duration_ms = max(daily_summaries.maximum_duration_ms, excluded.maximum_duration_ms),
  estimated_cost_usd_cents =
    daily_summaries.estimated_cost_usd_cents + excluded.estimated_cost_usd_cents,
  fallback_count = daily_summaries.fallback_count + excluded.fallback_count,
  cleanup_problem_count =
    daily_summaries.cleanup_problem_count + excluded.cleanup_problem_count`;

const DELETE_SUMMARISED_DETAIL_SQL = `
DELETE FROM usage_records
WHERE completed_at >= ?1 AND completed_at < ?2`;

const RETIRE_IDEMPOTENCY_DETAIL_SQL = `
UPDATE usage_record_idempotency
SET detail_retired = 1
WHERE idempotency_key_hash IN (
  SELECT idempotency_key_hash
  FROM usage_records
  WHERE completed_at >= ?1 AND completed_at < ?2
)`;

export class D1ReportingStore {
  readonly #database: D1DatabaseLike;
  readonly #subtle: SubtleCrypto;

  constructor(database: D1DatabaseLike, subtle: SubtleCrypto = crypto.subtle) {
    this.#database = database;
    this.#subtle = subtle;
  }

  async writeUsageRecord(idempotencyKey: string, value: unknown): Promise<UsageWriteOutcome> {
    const record = parseUsageRecord(value);
    const [keyHash, payloadHash] = await Promise.all([
      sha256Hex(idempotencyKey, this.#subtle),
      sha256Hex(canonicalUsageRecordJson(record), this.#subtle),
    ]);
    const values = [
      keyHash,
      payloadHash,
      record.repository,
      record.workflow,
      record.job,
      record.github_run_id,
      record.github_run_url,
      record.provider,
      record.capability_profile,
      record.started_at,
      record.completed_at,
      record.duration_ms,
      record.outcome,
      record.fallback_used ? 1 : 0,
      record.cleanup_problem ? 1 : 0,
      record.estimated_cost_usd_cents,
    ] as const;
    const [idempotencyResult, detailResult] = await this.#database.batch<StoredHashRow>([
      this.#database.prepare(INSERT_IDEMPOTENCY_SQL).bind(keyHash, payloadHash),
      this.#database.prepare(INSERT_USAGE_SQL).bind(...values),
    ]);
    if (idempotencyResult === undefined || detailResult === undefined) {
      throw new Error("D1 returned an incomplete idempotent write batch");
    }
    requireSuccessful(idempotencyResult);
    requireSuccessful(detailResult);

    if (idempotencyResult.results.length === 1 && detailResult.results.length === 1) {
      return "created";
    }
    if (idempotencyResult.results.length !== 0) {
      throw new Error("D1 created an idempotency marker without usage detail");
    }

    const existing = await this.#database
      .prepare(SELECT_USAGE_HASH_SQL)
      .bind(keyHash)
      .first<StoredHashRow>();
    if (existing === null) {
      throw new Error("idempotent write disappeared after a D1 conflict");
    }
    return existing.payload_hash === payloadHash ? "replayed" : "conflict";
  }

  async buildReport(windowDays: ReportWindowDays, generatedAt: Date): Promise<UsageReport> {
    const window = reportWindow(windowDays, generatedAt);
    const result = await this.#database
      .prepare(SELECT_REPORT_DETAIL_SQL)
      .bind(window.from_inclusive, window.to_exclusive)
      .all<StoredUsageRow>();
    requireSuccessful(result);
    return buildUsageReport(result.results.map(fromStoredUsageRow), windowDays, generatedAt);
  }

  async runRetention(now: Date): Promise<readonly string[]> {
    const cutoff = retentionCutoff(now);
    const datesResult = await this.#database
      .prepare(SELECT_EXPIRED_DATES_SQL)
      .bind(cutoff)
      .all<SummaryDateRow>();
    requireSuccessful(datesResult);

    const summarisedDates: string[] = [];
    for (const row of datesResult.results) {
      const { start, end } = utcDayBounds(row.summary_date);
      if (end > cutoff) {
        throw new Error("D1 returned a retention date which is not wholly expired");
      }
      const batch = await this.#database.batch([
        this.#database.prepare(UPSERT_DAILY_SUMMARY_SQL).bind(start, end),
        this.#database.prepare(RETIRE_IDEMPOTENCY_DETAIL_SQL).bind(start, end),
        this.#database.prepare(DELETE_SUMMARISED_DETAIL_SQL).bind(start, end),
      ]);
      for (const result of batch) {
        requireSuccessful(result);
      }
      summarisedDates.push(row.summary_date);
    }
    return summarisedDates;
  }
}

export function retentionCutoff(now: Date): string {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("retention time must be valid");
  }
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 365),
  ).toISOString();
}

function utcDayBounds(date: string): { readonly end: string; readonly start: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("D1 returned an invalid summary date");
  }
  const start = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== date) {
    throw new Error("D1 returned a non-existent summary date");
  }
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
  };
}

async function sha256Hex(value: string, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireSuccessful(result: D1ResultLike<unknown>): void {
  if (!result.success) {
    throw new Error("D1 statement failed");
  }
}

function fromStoredUsageRow(row: StoredUsageRow): UsageRecord {
  if (
    (row.fallback_used !== 0 && row.fallback_used !== 1) ||
    (row.cleanup_problem !== 0 && row.cleanup_problem !== 1)
  ) {
    throw new Error("D1 returned a malformed boolean");
  }

  return parseUsageRecord({
    repository: row.repository,
    workflow: row.workflow,
    job: row.job,
    github_run_id: row.github_run_id,
    github_run_url: row.github_run_url,
    provider: row.provider,
    capability_profile: row.capability_profile,
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: row.duration_ms,
    outcome: row.outcome,
    fallback_used: row.fallback_used === 1,
    cleanup_problem: row.cleanup_problem === 1,
    estimated_cost_usd_cents: row.estimated_cost_usd_cents,
  });
}
