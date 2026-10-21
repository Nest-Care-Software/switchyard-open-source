import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GITHUB_API_VERSION,
  GitHubRequestError,
  GitHubRestClient,
  type FetchLike,
} from "../src/index.js";

const REPOSITORY = { owner: "example-org", name: "example-workload" } as const;

describe("narrow GitHub fetch client", () => {
  it("uses attempt-specific, immutable routes and pinned request headers", async () => {
    const requests: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const fetch: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.includes("/contents/")) {
        return new Response("name: workflow", {
          status: 200,
          headers: { "content-type": "application/vnd.github.raw+json" },
        });
      }
      if (init?.method === "POST") {
        return Response.json({ id: 1 }, { status: 201 });
      }
      return Response.json({ ok: true });
    };
    const client = new GitHubRestClient({ accessToken: "test-token", fetch });

    await client.getWorkflowRunAttempt(REPOSITORY, "81", 2);
    await client.listJobsForWorkflowRunAttempt(REPOSITORY, "81", 2);
    await client.getCommit(REPOSITORY, "abcdef0123456789abcdef0123456789abcdef01");
    await client.getGitRef(REPOSITORY, "refs/heads/main");
    await client.getWorkflowBytes(
      REPOSITORY,
      ".github/workflows/ci.yml",
      "abcdef0123456789abcdef0123456789abcdef01",
    );
    await client.createCheckRun(REPOSITORY, { name: "Switchyard" });

    assert.ok(requests[0]?.url.endsWith("/actions/runs/81/attempts/2"));
    assert.ok(requests[1]?.url.endsWith("/actions/runs/81/attempts/2/jobs?per_page=100&page=1"));
    assert.ok(requests[2]?.url.includes("/commits/abcdef0123456789abcdef0123456789abcdef01"));
    assert.ok(requests[3]?.url.endsWith("/git/ref/heads/main"));
    assert.ok(requests[4]?.url.endsWith("?ref=abcdef0123456789abcdef0123456789abcdef01"));
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-token");
      assert.equal(headers.get("x-github-api-version"), GITHUB_API_VERSION);
      assert.equal(request.init?.redirect, "error");
    }
  });

  it("returns only redacted status metadata for API failures", async () => {
    const fetch: FetchLike = async () =>
      new Response('{"message":"token test-token and private job data"}', {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-github-request-id": "request-safe",
        },
      });
    const client = new GitHubRestClient({ accessToken: "test-token", fetch });

    let caught: unknown;
    try {
      await client.getRepository(REPOSITORY);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof GitHubRequestError);
    assert.deepEqual(caught.failure, {
      classification: "github-api-failure",
      code: "github-api-status",
      requestId: "request-safe",
      retryable: true,
      status: 503,
    });
    assert.equal(JSON.stringify(caught).includes("private job data"), false);
    assert.equal(caught.message.includes("test-token"), false);
  });
});
