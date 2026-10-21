import type { ApprovedBranchEvidence, ApprovedBranchEvidenceStore } from "@switchyard/core";

import type {
  GitHubRepositoryCoordinates,
  WorkloadGitHubClient,
  WorkloadGitHubClientProvider,
} from "../api.js";
import type {
  CheckRunCreationCoordinationResult,
  CheckRunCreationCoordinator,
  CheckRunCreationKey,
} from "../check-run-reporter.js";

export type FakeGitHubOperation =
  | "createCheckRun"
  | "getCheckRun"
  | "getCommit"
  | "getGitRef"
  | "getRepository"
  | "getWorkflowBytes"
  | "getWorkflowRunAttempt"
  | "listCheckRunsForCommit"
  | "listJobsForWorkflowRunAttempt"
  | "updateCheckRun";

export interface FakeGitHubRequest {
  readonly arguments: readonly unknown[];
  readonly operation: FakeGitHubOperation;
}

export class FakeWorkloadGitHubClient implements WorkloadGitHubClient {
  readonly requests: FakeGitHubRequest[] = [];
  readonly #responses: Map<FakeGitHubOperation, unknown[]>;

  constructor(responses: Partial<Record<FakeGitHubOperation, readonly unknown[]>> = {}) {
    this.#responses = new Map(
      Object.entries(responses).map(([operation, values]) => [
        operation as FakeGitHubOperation,
        [...values],
      ]),
    );
  }

  getRepository(repository: GitHubRepositoryCoordinates): Promise<unknown> {
    return this.#next("getRepository", [repository]);
  }

  getWorkflowRunAttempt(
    repository: GitHubRepositoryCoordinates,
    runId: string,
    runAttempt: number,
  ): Promise<unknown> {
    return this.#next("getWorkflowRunAttempt", [repository, runId, runAttempt]);
  }

  listJobsForWorkflowRunAttempt(
    repository: GitHubRepositoryCoordinates,
    runId: string,
    runAttempt: number,
  ): Promise<unknown> {
    return this.#next("listJobsForWorkflowRunAttempt", [repository, runId, runAttempt]);
  }

  getCheckRun(repository: GitHubRepositoryCoordinates, checkRunId: string): Promise<unknown> {
    return this.#next("getCheckRun", [repository, checkRunId]);
  }

  getCommit(repository: GitHubRepositoryCoordinates, commitSha: string): Promise<unknown> {
    return this.#next("getCommit", [repository, commitSha]);
  }

  getGitRef(repository: GitHubRepositoryCoordinates, ref: string): Promise<unknown> {
    return this.#next("getGitRef", [repository, ref]);
  }

  getWorkflowBytes(
    repository: GitHubRepositoryCoordinates,
    path: string,
    commitSha: string,
  ): Promise<Uint8Array> {
    return this.#next("getWorkflowBytes", [repository, path, commitSha]).then((value) => {
      if (!(value instanceof Uint8Array)) {
        throw new Error("Fake getWorkflowBytes response must be Uint8Array");
      }
      return value;
    });
  }

  listCheckRunsForCommit(
    repository: GitHubRepositoryCoordinates,
    commitSha: string,
    checkName: string,
  ): Promise<unknown> {
    return this.#next("listCheckRunsForCommit", [repository, commitSha, checkName]);
  }

  createCheckRun(
    repository: GitHubRepositoryCoordinates,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.#next("createCheckRun", [repository, body]);
  }

  updateCheckRun(
    repository: GitHubRepositoryCoordinates,
    checkRunId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.#next("updateCheckRun", [repository, checkRunId, body]);
  }

  async #next(
    operation: FakeGitHubOperation,
    requestArguments: readonly unknown[],
  ): Promise<unknown> {
    this.requests.push({ operation, arguments: requestArguments });
    const response = this.#responses.get(operation)?.shift();
    if (response === undefined) {
      throw new Error(`Fake GitHub client has no queued '${operation}' response`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

export class FakeWorkloadGitHubClientProvider implements WorkloadGitHubClientProvider {
  readonly client: WorkloadGitHubClient;
  calls = 0;

  constructor(client: WorkloadGitHubClient) {
    this.client = client;
  }

  async withWorkloadClient<T>(operation: (client: WorkloadGitHubClient) => Promise<T>): Promise<T> {
    this.calls += 1;
    return operation(this.client);
  }
}

export class FakeApprovedBranchEvidenceStore implements ApprovedBranchEvidenceStore {
  readonly loads: Array<{ readonly repositoryId: string; readonly runId: string }> = [];
  readonly records: ApprovedBranchEvidence[] = [];
  readonly #evidence = new Map<string, ApprovedBranchEvidence>();

  constructor(initialEvidence: readonly ApprovedBranchEvidence[] = []) {
    for (const evidence of initialEvidence) {
      this.#evidence.set(branchEvidenceKey(evidence), evidence);
    }
  }

  async load(input: {
    readonly repositoryId: string;
    readonly runId: string;
  }): Promise<unknown | null> {
    this.loads.push(input);
    return this.#evidence.get(branchEvidenceKey(input)) ?? null;
  }

  async recordInitial(
    evidence: ApprovedBranchEvidence,
  ): Promise<"conflict" | "matched" | "recorded"> {
    this.records.push(evidence);
    const key = branchEvidenceKey(evidence);
    const existing = this.#evidence.get(key);
    if (existing === undefined) {
      this.#evidence.set(key, evidence);
      return "recorded";
    }
    return JSON.stringify(existing) === JSON.stringify(evidence) ? "matched" : "conflict";
  }
}

export class FakeCheckRunCreationCoordinator implements CheckRunCreationCoordinator {
  readonly calls: CheckRunCreationKey[] = [];
  readonly #published = new Map<string, string>();
  readonly #running = new Map<string, Promise<CheckRunCreationCoordinationResult>>();

  async coordinate(
    key: CheckRunCreationKey,
    listOrCreate: () => Promise<string>,
  ): Promise<CheckRunCreationCoordinationResult> {
    this.calls.push(key);
    const storageKey = checkRunCreationKey(key);
    const published = this.#published.get(storageKey);
    if (published !== undefined) {
      return { checkRunId: published, outcome: "completed" };
    }
    const running = this.#running.get(storageKey);
    if (running !== undefined) {
      return running;
    }

    const publication = listOrCreate().then((checkRunId) => {
      this.#published.set(storageKey, checkRunId);
      return { checkRunId, outcome: "completed" } as const;
    });
    this.#running.set(storageKey, publication);
    try {
      return await publication;
    } finally {
      this.#running.delete(storageKey);
    }
  }
}

function branchEvidenceKey(input: {
  readonly repositoryId: string;
  readonly runId: string;
}): string {
  return `${input.repositoryId}:${input.runId}`;
}

function checkRunCreationKey(key: CheckRunCreationKey): string {
  return [
    key.repository.owner,
    key.repository.name,
    key.appSlug,
    key.headSha,
    key.allocationId,
  ].join(":");
}
