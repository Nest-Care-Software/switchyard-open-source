export const GITHUB_API_VERSION = "2026-03-10" as const;
export const GITHUB_API_BASE_URL = "https://api.github.com" as const;

export interface GitHubRepositoryCoordinates {
  readonly name: string;
  readonly owner: string;
}

export interface WorkloadGitHubClient {
  createCheckRun(
    repository: GitHubRepositoryCoordinates,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  getCheckRun(repository: GitHubRepositoryCoordinates, checkRunId: string): Promise<unknown>;
  getCommit(repository: GitHubRepositoryCoordinates, commitSha: string): Promise<unknown>;
  getGitRef(repository: GitHubRepositoryCoordinates, ref: string): Promise<unknown>;
  getRepository(repository: GitHubRepositoryCoordinates): Promise<unknown>;
  getWorkflowBytes(
    repository: GitHubRepositoryCoordinates,
    path: string,
    commitSha: string,
  ): Promise<Uint8Array>;
  getWorkflowRunAttempt(
    repository: GitHubRepositoryCoordinates,
    runId: string,
    runAttempt: number,
  ): Promise<unknown>;
  listCheckRunsForCommit(
    repository: GitHubRepositoryCoordinates,
    commitSha: string,
    checkName: string,
  ): Promise<unknown>;
  listJobsForWorkflowRunAttempt(
    repository: GitHubRepositoryCoordinates,
    runId: string,
    runAttempt: number,
    options?: { readonly page: number; readonly perPage: number },
  ): Promise<unknown>;
  updateCheckRun(
    repository: GitHubRepositoryCoordinates,
    checkRunId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface WorkloadGitHubClientProvider {
  withWorkloadClient<T>(
    operation: (client: WorkloadGitHubClient) => Promise<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class GitHubRestClient implements WorkloadGitHubClient {
  readonly #accessToken: string;
  readonly #apiBaseUrl: string;
  readonly #fetch: FetchLike;
  readonly #signal: AbortSignal | undefined;

  constructor(options: {
    readonly accessToken: string;
    readonly apiBaseUrl?: string;
    readonly fetch?: FetchLike;
    readonly signal?: AbortSignal;
  }) {
    this.#accessToken = options.accessToken;
    this.#apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal;
  }

  getRepository(repository: GitHubRepositoryCoordinates): Promise<unknown> {
    return this.#requestJson("GET", repositoryPath(repository));
  }

  getWorkflowRunAttempt(
    repository: GitHubRepositoryCoordinates,
    runId: string,
    runAttempt: number,
  ): Promise<unknown> {
    return this.#requestJson(
      "GET",
      `${repositoryPath(repository)}/actions/runs/${encodeURIComponent(runId)}/attempts/${runAttempt}`,
    );
  }

  listJobsForWorkflowRunAttempt(
    repository: GitHubRepositoryCoordinates,
    runId: string,
    runAttempt: number,
    options: { readonly page: number; readonly perPage: number } = { page: 1, perPage: 100 },
  ): Promise<unknown> {
    if (
      !Number.isSafeInteger(options.page) ||
      options.page < 1 ||
      !Number.isSafeInteger(options.perPage) ||
      options.perPage < 1 ||
      options.perPage > 100
    ) {
      return Promise.reject(GitHubRequestError.invalidResponse("github-pagination-invalid"));
    }
    return this.#requestJson(
      "GET",
      `${repositoryPath(repository)}/actions/runs/${encodeURIComponent(runId)}/attempts/${runAttempt}/jobs?per_page=${options.perPage}&page=${options.page}`,
    );
  }

  getCheckRun(repository: GitHubRepositoryCoordinates, checkRunId: string): Promise<unknown> {
    return this.#requestJson(
      "GET",
      `${repositoryPath(repository)}/check-runs/${encodeURIComponent(checkRunId)}`,
    );
  }

  getCommit(repository: GitHubRepositoryCoordinates, commitSha: string): Promise<unknown> {
    return this.#requestJson(
      "GET",
      `${repositoryPath(repository)}/commits/${encodeURIComponent(commitSha)}`,
    );
  }

  getGitRef(repository: GitHubRepositoryCoordinates, ref: string): Promise<unknown> {
    if (!ref.startsWith("refs/") || ref.length <= "refs/".length) {
      return Promise.reject(GitHubRequestError.invalidResponse("github-git-ref-invalid"));
    }
    const encodedRef = ref.slice("refs/".length).split("/").map(encodeURIComponent).join("/");
    return this.#requestJson("GET", `${repositoryPath(repository)}/git/ref/${encodedRef}`);
  }

  async getWorkflowBytes(
    repository: GitHubRepositoryCoordinates,
    path: string,
    commitSha: string,
  ): Promise<Uint8Array> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await this.#request(
      "GET",
      `${repositoryPath(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`,
      undefined,
      "application/vnd.github.raw+json",
    );
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > 1024 * 1024) {
      throw GitHubRequestError.invalidResponse("github-content-too-large", response);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) {
      throw GitHubRequestError.invalidResponse("github-content-size-invalid", response);
    }
    return bytes;
  }

  listCheckRunsForCommit(
    repository: GitHubRepositoryCoordinates,
    commitSha: string,
    checkName: string,
  ): Promise<unknown> {
    const query = new URLSearchParams({
      check_name: checkName,
      filter: "all",
      per_page: "100",
    });
    return this.#requestJson(
      "GET",
      `${repositoryPath(repository)}/commits/${encodeURIComponent(commitSha)}/check-runs?${query.toString()}`,
    );
  }

  createCheckRun(
    repository: GitHubRepositoryCoordinates,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.#requestJson("POST", `${repositoryPath(repository)}/check-runs`, body, 201);
  }

  updateCheckRun(
    repository: GitHubRepositoryCoordinates,
    checkRunId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.#requestJson(
      "PATCH",
      `${repositoryPath(repository)}/check-runs/${encodeURIComponent(checkRunId)}`,
      body,
    );
  }

  async #requestJson(
    method: "GET" | "PATCH" | "POST",
    path: string,
    body?: Readonly<Record<string, unknown>>,
    expectedStatus = 200,
  ): Promise<unknown> {
    const response = await this.#request(method, path, body);
    if (response.status !== expectedStatus) {
      throw GitHubRequestError.fromResponse("github-status-unexpected", response);
    }
    const contentType = response.headers.get("content-type");
    if (contentType === null || !contentType.toLowerCase().includes("application/json")) {
      throw GitHubRequestError.invalidResponse("github-content-type-invalid", response);
    }
    try {
      return await response.json();
    } catch {
      throw GitHubRequestError.invalidResponse("github-json-invalid", response);
    }
  }

  async #request(
    method: "GET" | "PATCH" | "POST",
    path: string,
    body?: Readonly<Record<string, unknown>>,
    accept = "application/vnd.github+json",
  ): Promise<Response> {
    let response: Response;
    try {
      const request: RequestInit = {
        method,
        headers: {
          accept,
          authorization: `Bearer ${this.#accessToken}`,
          "content-type": "application/json",
          "user-agent": "switchyard-github-adapter",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        redirect: "error",
        signal:
          this.#signal === undefined
            ? AbortSignal.timeout(10_000)
            : AbortSignal.any([this.#signal, AbortSignal.timeout(10_000)]),
      };
      if (body !== undefined) {
        request.body = JSON.stringify(body);
      }
      response = await this.#fetch(`${this.#apiBaseUrl}${path}`, request);
    } catch {
      throw new GitHubRequestError({
        classification: "github-api-failure",
        code: "github-network-failure",
        requestId: null,
        retryable: true,
        status: null,
      });
    }

    if (!response.ok) {
      throw GitHubRequestError.fromResponse("github-api-status", response);
    }
    return response;
  }
}

export interface SafeGitHubFailure {
  readonly classification: "github-api-failure" | "github-response-invalid";
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly status: number | null;
}

export class GitHubRequestError extends Error {
  readonly failure: SafeGitHubFailure;

  constructor(failure: SafeGitHubFailure) {
    super(`GitHub request failed (${failure.code})`);
    this.name = "GitHubRequestError";
    this.failure = failure;
  }

  static fromResponse(code: string, response: Response): GitHubRequestError {
    return new GitHubRequestError({
      classification: "github-api-failure",
      code,
      requestId: response.headers.get("x-github-request-id"),
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      status: response.status,
    });
  }

  static invalidResponse(code: string, response?: Response): GitHubRequestError {
    return new GitHubRequestError({
      classification: "github-response-invalid",
      code,
      requestId: response?.headers.get("x-github-request-id") ?? null,
      retryable: false,
      status: response?.status ?? null,
    });
  }
}

export function safeGitHubFailure(error: unknown): SafeGitHubFailure {
  if (error instanceof GitHubRequestError) {
    return error.failure;
  }
  return {
    classification: "github-response-invalid",
    code: "github-adapter-unexpected",
    requestId: null,
    retryable: false,
    status: null,
  };
}

function repositoryPath(repository: GitHubRepositoryCoordinates): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}
