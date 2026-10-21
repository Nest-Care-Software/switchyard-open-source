import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AllocationClientError, requestAllocation } from "../.github/actions/allocate/index.mjs";

const ALLOCATION_ID = `sy1-${"a".repeat(64)}`;

describe("standalone allocation client", () => {
  it("uses separate Entra and fresh per-call allocation proofs while honouring Retry-After", async () => {
    const calls = [];
    const waits = [];
    let proof = 0;
    const result = await requestAllocation(
      options({
        fetch: async (url, init) => {
          calls.push({ url, init });
          if (url.startsWith("https://oidc.invalid")) {
            const audience = new URL(url).searchParams.get("audience");
            if (audience === "api://entra-assertion") {
              return json(200, { value: "entra-assertion-token-value" });
            }
            proof += 1;
            return json(200, { value: `fresh-allocation-proof-${proof}` });
          }
          if (url.startsWith("https://login.microsoftonline.com")) {
            return json(200, {
              access_token: "entra-access-token-value",
              expires_in: 3600,
              token_type: "Bearer",
            });
          }
          const requestNumber = calls.filter(
            (call) => call.url === "https://api.invalid/api/v1/allocations",
          ).length;
          assert.equal(init.headers.Authorization, "Bearer entra-access-token-value");
          assert.equal(
            init.headers["X-Switchyard-GitHub-OIDC"],
            `fresh-allocation-proof-${requestNumber}`,
          );
          return requestNumber === 1
            ? json(202, { allocation_id: ALLOCATION_ID, status: "pending" }, { "Retry-After": "5" })
            : json(200, {
                allocation_id: ALLOCATION_ID,
                runner_label: "blacksmith-4vcpu-ubuntu-2404",
              });
        },
        wait: async (milliseconds) => waits.push(milliseconds),
      }),
    );

    assert.deepEqual(result, {
      allocation_id: ALLOCATION_ID,
      runner_label: "blacksmith-4vcpu-ubuntu-2404",
    });
    assert.equal(proof, 2);
    assert.deepEqual(waits, [5_000]);
    assert.equal(
      calls.filter((call) => call.url.includes("audience=api%3A%2F%2Fentra-assertion")).length,
      1,
    );
  });

  it("fails closed on a changed allocation ID, malformed retry interval and expired polling budget", async () => {
    for (const scenario of ["changed-id", "bad-retry", "expired"]) {
      let now = 0;
      let apiCalls = 0;
      await assert.rejects(
        () =>
          requestAllocation(
            options({
              monotonicNowMilliseconds: () => now,
              pollTimeoutMilliseconds: scenario === "expired" ? 1 : 60_000,
              wait: async () => {
                now += 5_000;
              },
              fetch: async (url) => {
                if (url.startsWith("https://oidc.invalid")) {
                  return json(200, { value: "oidc-token-value-long-enough" });
                }
                if (url.startsWith("https://login.microsoftonline.com")) {
                  return json(200, {
                    access_token: "entra-access-token-value",
                    expires_in: 3600,
                    token_type: "Bearer",
                  });
                }
                apiCalls += 1;
                if (apiCalls === 1 || scenario !== "changed-id") {
                  return json(
                    202,
                    { allocation_id: ALLOCATION_ID, status: "pending" },
                    { "Retry-After": scenario === "bad-retry" ? "0" : "5" },
                  );
                }
                return json(200, {
                  allocation_id: `sy1-${"b".repeat(64)}`,
                  runner_label: "managed-label",
                });
              },
            }),
          ),
        (error) => error instanceof AllocationClientError,
        scenario,
      );
    }
  });

  it("returns only redacted error codes", async () => {
    const secret = "secret-response-token";
    await assert.rejects(
      () =>
        requestAllocation(
          options({
            fetch: async (url) => {
              if (url.startsWith("https://oidc.invalid")) {
                return json(200, { value: "oidc-token-value-long-enough" });
              }
              if (url.startsWith("https://login.microsoftonline.com")) {
                return json(200, {
                  access_token: "entra-access-token-value",
                  expires_in: 3600,
                  token_type: "Bearer",
                });
              }
              return new Response(JSON.stringify({ error: "controller-unavailable", secret }), {
                status: 503,
              });
            },
          }),
        ),
      (error) => {
        assert.ok(error instanceof AllocationClientError);
        assert.equal(error.message.includes(secret), false);
        assert.equal(String(error.code).includes(secret), false);
        return true;
      },
    );
  });

  it("fails an expired fresh proof during polling instead of reusing the first proof", async () => {
    let proof = 0;
    let apiCalls = 0;
    await assert.rejects(
      () =>
        requestAllocation(
          options({
            fetch: async (url) => {
              if (url.startsWith("https://oidc.invalid")) {
                if (new URL(url).searchParams.get("audience") === "api://entra-assertion") {
                  return json(200, { value: "entra-assertion-token-value" });
                }
                proof += 1;
                return json(200, { value: `allocation-proof-${proof}-long-enough` });
              }
              if (url.startsWith("https://login.microsoftonline.com")) {
                return json(200, {
                  access_token: "entra-access-token-value",
                  expires_in: 3600,
                  token_type: "Bearer",
                });
              }
              apiCalls += 1;
              return apiCalls === 1
                ? json(
                    202,
                    { allocation_id: ALLOCATION_ID, status: "pending" },
                    { "Retry-After": "5" },
                  )
                : json(403, { error: "allocation-not-authorised" });
            },
          }),
        ),
      (error) =>
        error instanceof AllocationClientError && error.code === "allocation-not-authorised",
    );
    assert.equal(proof, 2);
    assert.equal(apiCalls, 2);
  });

  it("rejects ambiguous responses and labels that could inject GitHub outputs", async () => {
    for (const apiResponse of [
      new Response(
        `{"allocation_id":"${ALLOCATION_ID}","allocation_id":"${ALLOCATION_ID}","status":"pending"}`,
        { headers: { "Retry-After": "5" }, status: 202 },
      ),
      json(200, {
        allocation_id: ALLOCATION_ID,
        runner_label: "managed-label\nforged_output=attacker",
      }),
    ]) {
      await assert.rejects(
        () =>
          requestAllocation(
            options({
              fetch: standardFetch(() => apiResponse),
            }),
          ),
        (error) => error instanceof AllocationClientError && error.code === "internal-error",
      );
    }
  });

  it("requires a monotonic polling clock and a token that covers the polling budget", async () => {
    const times = [10, 9];
    await assert.rejects(
      () =>
        requestAllocation(
          options({
            fetch: standardFetch(() => json(500, { error: "must-not-be-reached" })),
            monotonicNowMilliseconds: () => times.shift(),
          }),
        ),
      (error) => error instanceof AllocationClientError && error.code === "controller-unavailable",
    );

    await assert.rejects(
      () =>
        requestAllocation(
          options({
            fetch: async (url) => {
              if (url.startsWith("https://oidc.invalid")) {
                return json(200, { value: "oidc-token-value-long-enough" });
              }
              return json(200, {
                access_token: "entra-access-token-value",
                expires_in: 1,
                token_type: "Bearer",
              });
            },
          }),
        ),
      (error) => error instanceof AllocationClientError && error.code === "authentication-required",
    );
  });

  it("rejects an API URL that could leak either bearer proof", async () => {
    for (const allocationApiUrl of [
      "http://api.invalid/api/v1/allocations",
      "https://attacker@api.invalid/api/v1/allocations",
      "https://api.invalid/api/v1/allocations?forward=attacker",
      "https://api.invalid/another-operation",
    ]) {
      await assert.rejects(
        () => requestAllocation(options({ allocationApiUrl })),
        (error) => error instanceof AllocationClientError && error.code === "invalid-request",
      );
    }
  });
});

function options(overrides = {}) {
  return {
    allocationApiAudience: "api://allocation-api",
    allocationApiUrl: "https://api.invalid/api/v1/allocations",
    allocationProofAudience: "api://allocation-proof",
    entraAssertionAudience: "api://entra-assertion",
    entraClientId: "client-id",
    entraTenantId: "tenant-id",
    monotonicNowMilliseconds: () => 0,
    oidcRequestToken: "github-runtime-request-token",
    oidcRequestUrl: "https://oidc.invalid/token",
    requestBody: '{"identity":{},"profile":"linux-x64-large","backupChoice":"Keep going"}',
    requestTimeoutMilliseconds: 1_000,
    wait: async () => undefined,
    ...overrides,
  };
}

function standardFetch(apiResponse) {
  return async (url) => {
    if (url.startsWith("https://oidc.invalid")) {
      return json(200, { value: "oidc-token-value-long-enough" });
    }
    if (url.startsWith("https://login.microsoftonline.com")) {
      return json(200, {
        access_token: "entra-access-token-value",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    return apiResponse();
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}
