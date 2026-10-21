-- Apply only to the switchyard-reporting D1 database created with jurisdiction = "eu".

CREATE TABLE usage_record_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  detail_retired INTEGER NOT NULL DEFAULT 0 CHECK (detail_retired IN (0, 1))
) STRICT, WITHOUT ROWID;

CREATE TABLE usage_records (
  idempotency_key_hash TEXT PRIMARY KEY NOT NULL
    REFERENCES usage_record_idempotency (idempotency_key_hash),
  repository TEXT NOT NULL CHECK (repository = 'example-org/example-workload'),
  workflow TEXT NOT NULL CHECK (workflow = '.github/workflows/ci.yml'),
  job TEXT NOT NULL CHECK (job = 'example-build'),
  github_run_id TEXT NOT NULL CHECK (github_run_id NOT GLOB '*[^0-9]*'),
  github_run_url TEXT NOT NULL CHECK (length(github_run_url) BETWEEN 1 AND 512),
  provider TEXT NOT NULL CHECK (provider IN ('azure', 'blacksmith')),
  capability_profile TEXT NOT NULL
    CHECK (capability_profile IN ('linux-x64-standard', 'linux-x64-large')),
  started_at TEXT NOT NULL CHECK (length(started_at) = 24),
  completed_at TEXT NOT NULL CHECK (length(completed_at) = 24 AND completed_at >= started_at),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('success', 'failure', 'cancelled', 'timed-out', 'abandoned')),
  fallback_used INTEGER NOT NULL CHECK (fallback_used IN (0, 1)),
  cleanup_problem INTEGER NOT NULL CHECK (cleanup_problem IN (0, 1)),
  estimated_cost_usd_cents INTEGER NOT NULL CHECK (estimated_cost_usd_cents >= 0)
) STRICT;

CREATE INDEX usage_records_completed_at
  ON usage_records (completed_at);

CREATE TABLE daily_summaries (
  summary_date TEXT NOT NULL CHECK (length(summary_date) = 10),
  provider TEXT NOT NULL CHECK (provider IN ('azure', 'blacksmith')),
  capability_profile TEXT NOT NULL
    CHECK (capability_profile IN ('linux-x64-standard', 'linux-x64-large')),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('success', 'failure', 'cancelled', 'timed-out', 'abandoned')),
  usage_count INTEGER NOT NULL CHECK (usage_count > 0),
  total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0),
  maximum_duration_ms INTEGER NOT NULL CHECK (maximum_duration_ms >= 0),
  estimated_cost_usd_cents INTEGER NOT NULL CHECK (estimated_cost_usd_cents >= 0),
  fallback_count INTEGER NOT NULL CHECK (fallback_count BETWEEN 0 AND usage_count),
  cleanup_problem_count INTEGER NOT NULL
    CHECK (cleanup_problem_count BETWEEN 0 AND usage_count),
  PRIMARY KEY (summary_date, provider, capability_profile, outcome)
) STRICT, WITHOUT ROWID;

CREATE INDEX daily_summaries_month
  ON daily_summaries (substr(summary_date, 1, 7));

CREATE VIEW monthly_summaries AS
SELECT
  substr(summary_date, 1, 7) AS summary_month,
  provider,
  capability_profile,
  outcome,
  sum(usage_count) AS usage_count,
  sum(total_duration_ms) AS total_duration_ms,
  max(maximum_duration_ms) AS maximum_duration_ms,
  sum(estimated_cost_usd_cents) AS estimated_cost_usd_cents,
  sum(fallback_count) AS fallback_count,
  sum(cleanup_problem_count) AS cleanup_problem_count
FROM daily_summaries
GROUP BY substr(summary_date, 1, 7), provider, capability_profile, outcome;
