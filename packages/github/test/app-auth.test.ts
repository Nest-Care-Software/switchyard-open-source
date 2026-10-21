import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  GITHUB_API_VERSION,
  GitHubAppTokenBroker,
  GitHubOperationClientFactory,
  GitHubRequestError,
  type FetchLike,
  type GitHubAppPrivateKeyCredentialProvider,
} from "../src/index.js";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    format: "pem",
    type: "pkcs8",
  })
  .toString();

const CONFIGURATION = {
  clientId: "Iv1.switchyard-test",
  installationId: "6001",
  workloadRepositoryId: "900000002",
  switchyardRepositoryId: "900000098",
} as const;

describe("least-privilege GitHub App installation tokens", () => {
  it("mints separate repository and operation tokens with exact reduced scopes", async () => {
    const captured: Array<{ readonly body: Record<string, unknown>; readonly jwt: string }> = [];
    let tokenNumber = 0;
    const fetch: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured.push({
        body,
        jwt: String(new Headers(init?.headers).get("authorization")).replace("Bearer ", ""),
      });
      tokenNumber += 1;
      return Response.json(
        {
          token: `installation-token-${tokenNumber}`,
          expires_at: "2026-08-25T13:00:00Z",
          permissions: body.permissions,
          ...repositoryConfirmation(body),
        },
        { status: 201 },
      );
    };
    const credentialProvider = new CountingCredentialProvider();
    const broker = new GitHubAppTokenBroker({
      configuration: CONFIGURATION,
      credentialProvider,
      fetch,
      now: () => new Date("2026-08-25T12:00:00Z"),
    });

    assert.equal(await broker.mintWorkloadToken(), "installation-token-1");
    assert.equal(await broker.mintWorkloadToken(), "installation-token-2");
    assert.equal(await broker.mintSwitchyardIssuesToken(), "installation-token-3");
    assert.equal(await broker.mintOrganisationRunnerToken(), "installation-token-4");

    assert.deepEqual(
      captured.map(({ body }) => body),
      [
        {
          repository_ids: [900000002],
          permissions: { actions: "read", checks: "write", contents: "read" },
        },
        {
          repository_ids: [900000002],
          permissions: { actions: "read", checks: "write", contents: "read" },
        },
        {
          repository_ids: [900000098],
          permissions: { issues: "write" },
        },
        {
          permissions: { organization_self_hosted_runners: "write" },
        },
      ],
    );
    assert.equal(credentialProvider.calls, 4);

    const [header, payload] = captured[0]?.jwt.split(".") ?? [];
    assert.deepEqual(JSON.parse(Buffer.from(header ?? "", "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >;
    assert.equal(claims.iss, CONFIGURATION.clientId);
    assert.equal(Number(claims.exp) - Number(claims.iat), 540);
  });

  it("mints a new Workload token for each high-level operation instead of caching it", async () => {
    let tokenRequests = 0;
    const fetch: FetchLike = async (_input, init) => {
      tokenRequests += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        {
          token: `token-${tokenRequests}`,
          expires_at: "2026-08-25T13:00:00Z",
          permissions: body.permissions,
          ...repositoryConfirmation(body),
        },
        { status: 201 },
      );
    };
    const broker = new GitHubAppTokenBroker({
      configuration: CONFIGURATION,
      credentialProvider: new CountingCredentialProvider(),
      fetch,
      now: () => new Date("2026-08-25T12:00:00Z"),
    });
    const factory = new GitHubOperationClientFactory({ tokenBroker: broker, fetch });

    await factory.withWorkloadClient(async () => undefined);
    await factory.withWorkloadClient(async () => undefined);

    assert.equal(tokenRequests, 2);
  });

  it("rejects broader granted permissions and never includes credentials or response bodies in errors", async () => {
    const leakedResponseText = "installation-token-SHOULD-NOT-LEAK";
    const fetch: FetchLike = async () =>
      new Response(leakedResponseText, {
        status: 500,
        headers: { "x-github-request-id": "safe-request-id" },
      });
    const broker = new GitHubAppTokenBroker({
      configuration: CONFIGURATION,
      credentialProvider: new CountingCredentialProvider(),
      fetch,
      now: () => new Date("2026-08-25T12:00:00Z"),
    });

    let caught: unknown;
    try {
      await broker.mintWorkloadToken();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof GitHubRequestError);
    const serialised = JSON.stringify(caught);
    assert.equal(serialised.includes(leakedResponseText), false);
    assert.equal(serialised.includes(PRIVATE_KEY.slice(0, 30)), false);
    assert.equal(caught.message.includes(leakedResponseText), false);
    assert.equal(caught.failure.requestId, "safe-request-id");

    const broaderFetch: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        {
          token: "not-returned",
          expires_at: "2026-08-25T13:00:00Z",
          permissions: { ...(body.permissions as object), administration: "write" },
          ...repositoryConfirmation(body),
        },
        { status: 201 },
      );
    };
    const broaderBroker = new GitHubAppTokenBroker({
      configuration: CONFIGURATION,
      credentialProvider: new CountingCredentialProvider(),
      fetch: broaderFetch,
      now: () => new Date("2026-08-25T12:00:00Z"),
    });
    await assert.rejects(
      () => broaderBroker.mintWorkloadToken(),
      (error: unknown) =>
        error instanceof GitHubRequestError &&
        error.failure.code === "github-token-response-invalid",
    );
  });

  it("uses the pinned GitHub API version for token requests", async () => {
    let apiVersion: string | null = null;
    const fetch: FetchLike = async (_input, init) => {
      apiVersion = new Headers(init?.headers).get("x-github-api-version");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        {
          token: "token",
          expires_at: "2026-08-25T13:00:00Z",
          permissions: body.permissions,
          ...repositoryConfirmation(body),
        },
        { status: 201 },
      );
    };
    const broker = new GitHubAppTokenBroker({
      configuration: CONFIGURATION,
      credentialProvider: new CountingCredentialProvider(),
      fetch,
      now: () => new Date("2026-08-25T12:00:00Z"),
    });

    await broker.mintWorkloadToken();

    assert.equal(apiVersion, GITHUB_API_VERSION);
  });
});

class CountingCredentialProvider implements GitHubAppPrivateKeyCredentialProvider {
  calls = 0;

  async loadPrivateKey(): Promise<string> {
    this.calls += 1;
    return PRIVATE_KEY;
  }
}

function repositoryConfirmation(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.repository_ids)) {
    return {};
  }
  return {
    repository_selection: "selected",
    repositories: body.repository_ids.map((id) => ({ id })),
  };
}
