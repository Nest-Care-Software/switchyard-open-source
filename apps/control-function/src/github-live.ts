import type { AllocationIdentity } from "@switchyard/core";
import { azureRunnerLabelForAllocation } from "@switchyard/core";
import type { AzureRunnerGitHubPort, ExactRunnerObservation } from "@switchyard/azure-worker";
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  type GitHubOperationClientFactory,
  GitHubRequestError,
} from "@switchyard/github";
import type { GitHubJobObservation, GitHubWorkloadObservationPort } from "@switchyard/reconciler";

const MAX_RUNNER_PAGES = 20;
const RUNNER_PAGE_SIZE = 100;
const RUNNER_ABSENCE_SEPARATION_MILLISECONDS = 2_000;
const RUNNER_FENCE_TIMEOUT_MILLISECONDS = 20_000;

export class LiveGitHubWorkloadObservation implements GitHubWorkloadObservationPort {
  readonly #clients: GitHubOperationClientFactory;
  readonly #repository: { readonly name: string; readonly owner: string };
  readonly #repositoryId: string;

  constructor(options: {
    readonly clients: GitHubOperationClientFactory;
    readonly repository: { readonly id: string; readonly name: string; readonly owner: string };
  }) {
    this.#clients = options.clients;
    this.#repositoryId = positiveDecimal(options.repository.id, "repository.id");
    this.#repository = {
      name: bounded(options.repository.name, "repository.name", 100),
      owner: bounded(options.repository.owner, "repository.owner", 100),
    };
  }

  async getRun(
    identity: AllocationIdentity,
    options: { readonly signal: AbortSignal },
  ): Promise<unknown> {
    requireIdentityRepository(identity, this.#repositoryId);
    const value = await this.#clients.withWorkloadClient(
      (client) =>
        client.getWorkflowRunAttempt(this.#repository, identity.run_id, identity.run_attempt),
      { signal: options.signal },
    );
    const run = record(value, "workflowRun");
    if (
      positiveDecimal(run.id, "workflowRun.id") !== identity.run_id ||
      positiveInteger(run.run_attempt, "workflowRun.run_attempt") !== identity.run_attempt ||
      positiveDecimal(record(run.repository, "workflowRun.repository").id, "repository.id") !==
        identity.repository_id
    ) {
      throw invalidGitHub("github-run-identity-mismatch");
    }
    const status = bounded(run.status, "workflowRun.status", 64);
    const terminal = status === "completed";
    if (!terminal && status !== "queued" && status !== "in_progress" && status !== "waiting") {
      throw invalidGitHub("github-run-status-invalid");
    }
    return {
      concludedAt: terminal ? canonicalInstant(run.updated_at, "workflowRun.updated_at") : null,
      conclusion: terminal ? terminalConclusion(run.conclusion) : null,
      repositoryId: identity.repository_id,
      runAttempt: identity.run_attempt,
      runId: identity.run_id,
      state: terminal ? "terminal" : "active",
    };
  }

  async listJobs(input: {
    readonly continuationToken?: string;
    readonly identity: AllocationIdentity;
    readonly pageSize: number;
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    requireIdentityRepository(input.identity, this.#repositoryId);
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
      throw invalidGitHub("github-job-page-size-invalid");
    }
    const page =
      input.continuationToken === undefined
        ? 1
        : positiveInteger(input.continuationToken, "continuationToken");
    const value = await this.#clients.withWorkloadClient(
      (client) =>
        client.listJobsForWorkflowRunAttempt(
          this.#repository,
          input.identity.run_id,
          input.identity.run_attempt,
          { page, perPage: input.pageSize },
        ),
      { signal: input.signal },
    );
    const envelope = record(value, "workflowJobs");
    if (!Array.isArray(envelope.jobs) || envelope.jobs.length > input.pageSize) {
      throw invalidGitHub("github-job-page-shape-invalid");
    }
    const jobs = envelope.jobs.map(parseJob);
    return {
      continuationToken: jobs.length === input.pageSize ? String(page + 1) : null,
      jobs,
      repositoryId: input.identity.repository_id,
      runAttempt: input.identity.run_attempt,
      runId: input.identity.run_id,
    };
  }
}

export class LiveGitHubRunnerRegistration implements AzureRunnerGitHubPort {
  readonly #apiBaseUrl: string;
  readonly #clients: GitHubOperationClientFactory;
  readonly #fetch: typeof globalThis.fetch;
  readonly #organisation: string;
  readonly #runnerGroupId: number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: {
    readonly clients: GitHubOperationClientFactory;
    readonly organisation: string;
    readonly runnerGroupId: number;
    readonly apiBaseUrl?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }) {
    this.#clients = options.clients;
    this.#organisation = bounded(options.organisation, "organisation", 100);
    this.#runnerGroupId = positiveInteger(options.runnerGroupId, "runnerGroupId");
    this.#apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#wait = options.wait ?? cancellableWait;
  }

  async mintJitConfiguration(input: {
    readonly allocationId: string;
    readonly runnerLabel: string;
  }) {
    const runnerLabel = exactRunnerLabel(input.allocationId, input.runnerLabel);
    return this.#clients.withOrganisationRunnerToken(async (token) => {
      const digest = input.allocationId.slice("sy1-".length);
      const value = await this.#json(
        token,
        "POST",
        `/orgs/${encodeURIComponent(this.#organisation)}/actions/runners/generate-jitconfig`,
        {
          labels: [runnerLabel],
          name: `swy-${digest.slice(0, 24)}-g1`,
          runner_group_id: this.#runnerGroupId,
          work_folder: "_work",
        },
        201,
      );
      const response = record(value, "jitConfiguration");
      const runner = record(response.runner, "jitConfiguration.runner");
      const encodedJitConfiguration = bounded(
        response.encoded_jit_config,
        "jitConfiguration.encoded_jit_config",
        65_536,
      );
      if (!runnerHasExactLabel(runner, runnerLabel)) {
        throw invalidGitHub("github-jit-runner-label-mismatch");
      }
      return {
        encodedJitConfiguration,
        runnerRegistrationId: positiveDecimal(runner.id, "jitConfiguration.runner.id"),
      };
    });
  }

  async observeExactRunner(input: {
    readonly runnerLabel: string;
  }): Promise<ExactRunnerObservation> {
    validateUniqueRunnerLabel(input.runnerLabel);
    return this.#clients.withOrganisationRunnerToken(async (token) => {
      const matching = await this.#matchingRunners(token, input.runnerLabel);
      const checkedAt = new Date().toISOString();
      if (matching.length === 0) return { checkedAt, outcome: "absent" };
      if (matching.length > 1) {
        return {
          checkedAt,
          outcome: "ambiguous",
          runnerRegistrationIds: matching.map((runner) => runner.id),
        };
      }
      const runner = matching[0];
      if (runner === undefined) throw invalidGitHub("github-runner-observation-invalid");
      return {
        checkedAt,
        idle: !runner.busy,
        online: runner.status === "online",
        outcome: "exact",
        runnerRegistrationId: runner.id,
      };
    });
  }

  async fenceRunner(input: {
    readonly runnerLabel: string;
    readonly runnerRegistrationId: string | null;
  }) {
    validateUniqueRunnerLabel(input.runnerLabel);
    if (input.runnerRegistrationId !== null) {
      positiveDecimal(input.runnerRegistrationId, "runnerRegistrationId");
    }
    return this.#clients.withOrganisationRunnerToken(async (token) => {
      const fenceSignal = AbortSignal.timeout(RUNNER_FENCE_TIMEOUT_MILLISECONDS);
      let consecutiveAbsenceScans = 0;
      for (let pass = 0; pass < 5; pass += 1) {
        if (pass > 0) {
          await this.#wait(RUNNER_ABSENCE_SEPARATION_MILLISECONDS, fenceSignal);
        }
        const matching = await this.#matchingRunners(token, input.runnerLabel, fenceSignal);
        if (matching.length === 0) {
          consecutiveAbsenceScans += 1;
          if (consecutiveAbsenceScans === 2) {
            return {
              allMatchingRegistrationsAbsent: true as const,
              runnerLabel: input.runnerLabel,
              settledAt: new Date().toISOString(),
            };
          }
          continue;
        }
        consecutiveAbsenceScans = 0;
        for (const runner of matching) {
          await this.#empty(
            token,
            "DELETE",
            `/orgs/${encodeURIComponent(this.#organisation)}/actions/runners/${runner.id}`,
            204,
            fenceSignal,
          );
        }
      }
      throw invalidGitHub("github-runner-fence-not-confirmed");
    });
  }

  async #matchingRunners(token: string, runnerLabel: string, signal?: AbortSignal) {
    const matching: Array<{
      readonly busy: boolean;
      readonly id: string;
      readonly status: string;
    }> = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_RUNNER_PAGES; page += 1) {
      const value = await this.#json(
        token,
        "GET",
        `/orgs/${encodeURIComponent(this.#organisation)}/actions/runners?per_page=${RUNNER_PAGE_SIZE}&page=${page}`,
        undefined,
        200,
        signal,
      );
      const envelope = record(value, "runners");
      if (!Array.isArray(envelope.runners) || envelope.runners.length > RUNNER_PAGE_SIZE) {
        throw invalidGitHub("github-runner-page-invalid");
      }
      for (const raw of envelope.runners) {
        const runner = record(raw, "runner");
        if (!runnerHasExactLabel(runner, runnerLabel)) continue;
        const id = positiveDecimal(runner.id, "runner.id");
        if (seen.has(id)) throw invalidGitHub("github-runner-page-duplicate");
        seen.add(id);
        const status = bounded(runner.status, "runner.status", 32);
        if (status !== "online" && status !== "offline") {
          throw invalidGitHub("github-runner-status-invalid");
        }
        if (typeof runner.busy !== "boolean") throw invalidGitHub("github-runner-busy-invalid");
        matching.push({ busy: runner.busy, id, status });
      }
      if (envelope.runners.length < RUNNER_PAGE_SIZE) return matching;
    }
    throw invalidGitHub("github-runner-pagination-exhausted");
  }

  async #json(
    token: string,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    expectedStatus = 200,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#request(token, method, path, body, signal);
    if (response.status !== expectedStatus)
      throw GitHubRequestError.fromResponse("github-runner-status", response);
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.includes("application/json"))
      throw invalidGitHub("github-runner-content-type-invalid");
    try {
      return await response.json();
    } catch {
      throw invalidGitHub("github-runner-json-invalid");
    }
  }

  async #empty(
    token: string,
    method: "DELETE",
    path: string,
    expectedStatus: number,
    signal?: AbortSignal,
  ) {
    const response = await this.#request(token, method, path, undefined, signal);
    if (response.status !== expectedStatus)
      throw GitHubRequestError.fromResponse("github-runner-delete-status", response);
  }

  async #request(
    token: string,
    method: "DELETE" | "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    outerSignal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.#fetch(`${this.#apiBaseUrl}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "switchyard-control-function",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        method,
        redirect: "error",
        signal:
          outerSignal === undefined
            ? AbortSignal.timeout(10_000)
            : AbortSignal.any([outerSignal, AbortSignal.timeout(10_000)]),
      });
    } catch {
      throw new GitHubRequestError({
        classification: "github-api-failure",
        code: "github-runner-network-failure",
        requestId: null,
        retryable: true,
        status: null,
      });
    }
  }
}

async function cancellableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseJob(value: unknown): GitHubJobObservation {
  const job = record(value, "job");
  const status = bounded(job.status, "job.status", 64);
  const state =
    status === "completed"
      ? "terminal"
      : status === "in_progress"
        ? "in_progress"
        : status === "queued" || status === "waiting"
          ? "queued"
          : null;
  if (state === null) throw invalidGitHub("github-job-status-invalid");
  const labels = job.labels;
  if (
    !Array.isArray(labels) ||
    labels.length > 100 ||
    labels.some((label) => typeof label !== "string" || label.length < 1 || label.length > 256)
  ) {
    throw invalidGitHub("github-job-labels-invalid");
  }
  return {
    concludedAt:
      state === "terminal" ? canonicalInstant(job.completed_at, "job.completed_at") : null,
    conclusion: state === "terminal" ? terminalConclusion(job.conclusion) : null,
    githubJobId: positiveDecimal(job.id, "job.id"),
    jobName: bounded(job.name, "job.name", 256),
    runnerLabels: [...labels] as string[],
    startedAt: state === "queued" ? null : canonicalInstant(job.started_at, "job.started_at"),
    state,
  };
}

function terminalConclusion(value: unknown): GitHubJobObservation["conclusion"] {
  const conclusion = bounded(value, "conclusion", 64);
  if (conclusion === "success") return "succeeded";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "timed_out") return "timed_out";
  return "failed";
}

function canonicalInstant(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw invalidGitHub(`${path}-invalid`);
  return new Date(value).toISOString();
}

function runnerHasExactLabel(runner: Record<string, unknown>, expected: string): boolean {
  if (!Array.isArray(runner.labels) || runner.labels.length > 100)
    throw invalidGitHub("github-runner-labels-invalid");
  const labels = runner.labels.map((entry) =>
    bounded(record(entry, "runner.label").name, "runner.label.name", 256),
  );
  const switchyardLabels = labels.filter((label) => /^switchyard/i.test(label));
  if (
    switchyardLabels.some((label) => !/^switchyard-sy1-[a-f0-9]{64}$/i.test(label)) ||
    switchyardLabels.length > 1
  ) {
    throw invalidGitHub("github-runner-switchyard-labels-invalid");
  }
  return switchyardLabels[0]?.toLowerCase() === expected.toLowerCase();
}

function exactRunnerLabel(allocationId: string, value: string): string {
  const expected = azureRunnerLabelForAllocation(allocationId);
  if (value !== expected) throw new TypeError("runner label does not match allocation");
  return validateUniqueRunnerLabel(value);
}

function validateUniqueRunnerLabel(value: string): string {
  if (!/^switchyard-sy1-[a-f0-9]{64}$/.test(value)) throw new TypeError("runner label is invalid");
  return value;
}

function requireIdentityRepository(identity: AllocationIdentity, repositoryId: string): void {
  if (identity.repository_id !== repositoryId) throw new TypeError("repository identity mismatch");
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalidGitHub(`${path}-shape-invalid`);
  return value as Record<string, unknown>;
}

function bounded(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw invalidGitHub(`${path}-invalid`);
  return value;
}

function positiveDecimal(value: unknown, path: string): string {
  const candidate =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof candidate !== "string" || !/^[1-9][0-9]*$/.test(candidate))
    throw invalidGitHub(`${path}-invalid`);
  return candidate;
}

function positiveInteger(value: unknown, path: string): number {
  const candidate =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1)
    throw invalidGitHub(`${path}-invalid`);
  return candidate as number;
}

function invalidGitHub(code: string): GitHubRequestError {
  return GitHubRequestError.invalidResponse(code);
}
