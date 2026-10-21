import { sign } from "node:crypto";

import {
  ContractValidationError,
  requireAllowedKeys,
  requireExactKeys,
  requireNonEmptyString,
  requirePositiveDecimalString,
  requireRecord,
} from "@switchyard/core";

import {
  type FetchLike,
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GitHubRequestError,
  GitHubRestClient,
  type WorkloadGitHubClient,
  type WorkloadGitHubClientProvider,
} from "./api.js";

export interface GitHubAppPrivateKeyCredentialProvider {
  loadPrivateKey(): Promise<string>;
}

export interface GitHubAppInstallationConfiguration {
  readonly clientId: string;
  readonly installationId: string;
  readonly workloadRepositoryId: string;
  readonly switchyardRepositoryId: string;
}

export type InstallationTokenPurpose =
  | "organisation-runner-operation"
  | "workload-trust-and-checks"
  | "switchyard-issues";

interface InstallationTokenRequest {
  readonly permissions: Readonly<Record<string, "read" | "write">>;
  readonly repository_ids?: readonly number[];
}

export class GitHubAppTokenBroker {
  readonly #apiBaseUrl: string;
  readonly #configuration: GitHubAppInstallationConfiguration;
  readonly #credentialProvider: GitHubAppPrivateKeyCredentialProvider;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(options: {
    readonly configuration: GitHubAppInstallationConfiguration;
    readonly credentialProvider: GitHubAppPrivateKeyCredentialProvider;
    readonly apiBaseUrl?: string;
    readonly fetch?: FetchLike;
    readonly now?: () => Date;
  }) {
    this.#configuration = parseConfiguration(options.configuration);
    this.#credentialProvider = options.credentialProvider;
    this.#apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  mintWorkloadToken(options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    return this.#mintToken(
      "workload-trust-and-checks",
      {
        repository_ids: [toSafeGitHubNumber(this.#configuration.workloadRepositoryId)],
        permissions: {
          actions: "read",
          checks: "write",
          contents: "read",
        },
      },
      options,
    );
  }

  mintSwitchyardIssuesToken(): Promise<string> {
    return this.#mintToken("switchyard-issues", {
      repository_ids: [toSafeGitHubNumber(this.#configuration.switchyardRepositoryId)],
      permissions: { issues: "write" },
    });
  }

  mintOrganisationRunnerToken(): Promise<string> {
    return this.#mintToken("organisation-runner-operation", {
      permissions: { organization_self_hosted_runners: "write" },
    });
  }

  async #mintToken(
    purpose: InstallationTokenPurpose,
    request: InstallationTokenRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<string> {
    const now = this.#now();
    if (!Number.isFinite(now.valueOf())) {
      throw GitHubRequestError.invalidResponse("github-auth-clock-invalid");
    }

    let privateKey = "";
    let appJwt = "";
    try {
      privateKey = await this.#credentialProvider.loadPrivateKey();
      if (typeof privateKey !== "string" || privateKey.length === 0) {
        throw GitHubRequestError.invalidResponse("github-private-key-unavailable");
      }
      appJwt = createAppJwt(this.#configuration.clientId, privateKey, now);
    } catch (error) {
      if (error instanceof GitHubRequestError) {
        throw error;
      }
      throw GitHubRequestError.invalidResponse("github-app-jwt-signing-failed");
    } finally {
      privateKey = "";
    }

    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#apiBaseUrl}/app/installations/${encodeURIComponent(
          this.#configuration.installationId,
        )}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${appJwt}`,
            "content-type": "application/json",
            "user-agent": "switchyard-github-adapter",
            "x-github-api-version": GITHUB_API_VERSION,
          },
          body: JSON.stringify(request),
          redirect: "error",
          signal:
            options.signal === undefined
              ? AbortSignal.timeout(10_000)
              : AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
        },
      );
    } catch {
      throw new GitHubRequestError({
        classification: "github-api-failure",
        code: "github-token-network-failure",
        requestId: null,
        retryable: true,
        status: null,
      });
    } finally {
      appJwt = "";
    }

    if (response.status !== 201) {
      throw GitHubRequestError.fromResponse("github-token-status", response);
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw GitHubRequestError.invalidResponse("github-token-json-invalid", response);
    }

    return parseInstallationTokenResponse(value, purpose, request, now, response);
  }
}

export class GitHubOperationClientFactory implements WorkloadGitHubClientProvider {
  readonly #apiBaseUrl: string;
  readonly #fetch: FetchLike;
  readonly #tokenBroker: GitHubAppTokenBroker;

  constructor(options: {
    readonly tokenBroker: GitHubAppTokenBroker;
    readonly apiBaseUrl?: string;
    readonly fetch?: FetchLike;
  }) {
    this.#tokenBroker = options.tokenBroker;
    this.#apiBaseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async withWorkloadClient<T>(
    operation: (client: WorkloadGitHubClient) => Promise<T>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    let accessToken = await this.#tokenBroker.mintWorkloadToken(options);
    try {
      const client = new GitHubRestClient({
        accessToken,
        apiBaseUrl: this.#apiBaseUrl,
        fetch: this.#fetch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return await operation(client);
    } finally {
      accessToken = "";
    }
  }

  async withSwitchyardIssuesToken<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    let accessToken = await this.#tokenBroker.mintSwitchyardIssuesToken();
    try {
      return await operation(accessToken);
    } finally {
      accessToken = "";
    }
  }

  async withOrganisationRunnerToken<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    let accessToken = await this.#tokenBroker.mintOrganisationRunnerToken();
    try {
      return await operation(accessToken);
    } finally {
      accessToken = "";
    }
  }
}

function createAppJwt(clientId: string, privateKey: string, now: Date): string {
  const issuedAt = Math.floor(now.valueOf() / 1000) - 60;
  const header = encodeJwtPart({ alg: "RS256", typ: "JWT" });
  const payload = encodeJwtPart({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: clientId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function encodeJwtPart(value: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseConfiguration(value: unknown): GitHubAppInstallationConfiguration {
  const record = requireRecord(value, "githubAppInstallationConfiguration");
  requireExactKeys(
    record,
    ["clientId", "installationId", "workloadRepositoryId", "switchyardRepositoryId"],
    "githubAppInstallationConfiguration",
  );

  return {
    clientId: requireNonEmptyString(record.clientId, "githubAppInstallationConfiguration.clientId"),
    installationId: requirePositiveDecimalString(
      record.installationId,
      "githubAppInstallationConfiguration.installationId",
    ),
    workloadRepositoryId: requirePositiveDecimalString(
      record.workloadRepositoryId,
      "githubAppInstallationConfiguration.workloadRepositoryId",
    ),
    switchyardRepositoryId: requirePositiveDecimalString(
      record.switchyardRepositoryId,
      "githubAppInstallationConfiguration.switchyardRepositoryId",
    ),
  };
}

function parseInstallationTokenResponse(
  value: unknown,
  purpose: InstallationTokenPurpose,
  request: InstallationTokenRequest,
  now: Date,
  response: Response,
): string {
  try {
    const record = requireRecord(value, "githubInstallationToken");
    const token = requireNonEmptyString(record.token, "githubInstallationToken.token");
    const expiresAt = requireNonEmptyString(
      record.expires_at,
      "githubInstallationToken.expires_at",
    );
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.valueOf()) {
      throw new ContractValidationError(
        "githubInstallationToken.expires_at",
        "must be a future ISO timestamp",
      );
    }

    const permissions = requireRecord(record.permissions, "githubInstallationToken.permissions");
    const allowedPermissionKeys = [...Object.keys(request.permissions), "metadata"];
    requireAllowedKeys(permissions, allowedPermissionKeys, "githubInstallationToken.permissions");
    for (const [permission, expected] of Object.entries(request.permissions)) {
      if (permissions[permission] !== expected) {
        throw new ContractValidationError(
          `githubInstallationToken.permissions.${permission}`,
          `does not match the '${purpose}' request`,
        );
      }
    }
    if (Object.hasOwn(permissions, "metadata") && permissions.metadata !== "read") {
      throw new ContractValidationError(
        "githubInstallationToken.permissions.metadata",
        "may only contain GitHub's implicit read permission",
      );
    }
    if (request.repository_ids !== undefined) {
      if (record.repository_selection !== "selected" || !Array.isArray(record.repositories)) {
        throw new ContractValidationError(
          "githubInstallationToken.repositories",
          "must confirm the requested selected repositories",
        );
      }
      const grantedIds = record.repositories.map((repositoryValue, index) => {
        const repository = requireRecord(
          repositoryValue,
          `githubInstallationToken.repositories[${index}]`,
        );
        if (typeof repository.id !== "number" || !Number.isSafeInteger(repository.id)) {
          throw new ContractValidationError(
            `githubInstallationToken.repositories[${index}].id`,
            "must be a safe integer",
          );
        }
        return repository.id;
      });
      if (
        grantedIds.length !== request.repository_ids.length ||
        grantedIds.some((id, index) => id !== request.repository_ids?.[index])
      ) {
        throw new ContractValidationError(
          "githubInstallationToken.repositories",
          "do not match the requested repository restriction",
        );
      }
    }
    return token;
  } catch (error) {
    if (error instanceof GitHubRequestError) {
      throw error;
    }
    throw GitHubRequestError.invalidResponse("github-token-response-invalid", response);
  }
}

function toSafeGitHubNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw GitHubRequestError.invalidResponse("github-repository-id-out-of-range");
  }
  return parsed;
}
