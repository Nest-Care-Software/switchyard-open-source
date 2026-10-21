import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AllocationServiceError,
  createAllocationHttpHandler,
  type AllocationHttpRequest,
} from "../src/index.js";
import { requestBody } from "./fixtures.js";

const ALLOCATION_ID = `sy1-${"a".repeat(64)}`;

describe("allocation HTTP contract", () => {
  it("returns exact ready and pending JSON with safety headers", async () => {
    const inputs: unknown[] = [];
    const ready = createAllocationHttpHandler({
      allocate: async (input) => {
        inputs.push(input);
        return {
          allocationId: ALLOCATION_ID,
          runnerLabel: "blacksmith-4vcpu-ubuntu-2404",
          status: "ready",
        };
      },
    });
    const readyResponse = await ready(validRequest());
    assert.equal(readyResponse.status, 200);
    assert.equal(
      readyResponse.body,
      JSON.stringify({
        runner_label: "blacksmith-4vcpu-ubuntu-2404",
        allocation_id: ALLOCATION_ID,
      }),
    );
    assertSafetyHeaders(readyResponse.headers);
    assert.deepEqual(inputs, [
      {
        entraProof: "mapped-principal",
        githubOidcJwt: "fresh.github.proof",
        requestBody: requestBody(),
      },
    ]);

    const pending = createAllocationHttpHandler({
      allocate: async () => ({ allocationId: ALLOCATION_ID, status: "pending" }),
    });
    const pendingResponse = await pending(validRequest());
    assert.equal(pendingResponse.status, 202);
    assert.equal(pendingResponse.headers["Retry-After"], "5");
    assert.equal(
      pendingResponse.body,
      JSON.stringify({ allocation_id: ALLOCATION_ID, status: "pending" }),
    );
    assertSafetyHeaders(pendingResponse.headers);
  });

  it("rejects method, query, media type, malformed and duplicate-key JSON before service", async () => {
    let calls = 0;
    const handler = createAllocationHttpHandler({
      allocate: async () => {
        calls += 1;
        return { allocationId: ALLOCATION_ID, status: "pending" };
      },
    });
    const cases: ReadonlyArray<[Partial<AllocationHttpRequest>, number, string]> = [
      [{ method: "GET" }, 405, "method-not-allowed"],
      [{ url: "/api/v1/allocations?poll=true" }, 400, "invalid-request"],
      [
        { headers: replaceHeader(validHeaders(), "content-type", "text/plain") },
        415,
        "unsupported-media-type",
      ],
      [{ body: "{" }, 400, "invalid-request"],
      [
        {
          body: requestBody().replace(
            '"profile":"linux-x64-large"',
            '"profile":"linux-x64-large","profile":"linux-x64-standard"',
          ),
        },
        400,
        "invalid-request",
      ],
      [
        { body: requestBody().replace(/}$/, ',"runner_label":"attacker"}') },
        400,
        "invalid-request",
      ],
      [
        {
          body: new Uint8Array([0xc3, 0x28]),
        },
        400,
        "invalid-request",
      ],
      [{ body: "x".repeat(4_097) }, 413, "request-too-large"],
    ];
    for (const [override, expectedStatus, code] of cases) {
      const response = await handler(validRequest(override));
      assert.equal(response.status, expectedStatus, code);
      assert.equal(response.body, JSON.stringify({ error: code }), code);
      assertSafetyHeaders(response.headers);
      if (expectedStatus === 405) assert.equal(response.headers.Allow, "POST");
    }
    assert.equal(calls, 0);
  });

  it("rejects missing, duplicate and oversized identity headers without exposing values", async () => {
    const secret = "credential-that-must-not-escape";
    const handler = createAllocationHttpHandler({
      allocate: async () => {
        throw new Error(secret);
      },
    });
    for (const [headers, status, code] of [
      [withoutHeader(validHeaders(), "authorization"), 401, "authentication-required"],
      [[...validHeaders(), ["Authorization", `Bearer ${secret}`]], 401, "authentication-required"],
      [withoutHeader(validHeaders(), "x-ms-client-principal"), 401, "authentication-required"],
      [[...validHeaders(), ["X-MS-CLIENT-PRINCIPAL", secret]], 401, "authentication-required"],
      [withoutHeader(validHeaders(), "x-switchyard-github-oidc"), 401, "authentication-required"],
      [[...validHeaders(), ["X-Switchyard-GitHub-OIDC", secret]], 403, "allocation-not-authorised"],
      [
        replaceHeader(validHeaders(), "x-switchyard-github-oidc", "x".repeat(24 * 1024 + 1)),
        403,
        "allocation-not-authorised",
      ],
    ] as const) {
      const response = await handler(validRequest({ headers }));
      assert.equal(response.status, status);
      assert.equal(response.body, JSON.stringify({ error: code }));
      assert.equal(response.body.includes(secret), false);
    }
    const internal = await handler(validRequest());
    assert.equal(internal.status, 500);
    assert.equal(internal.body, JSON.stringify({ error: "internal-error" }));
    assert.equal(internal.body.includes(secret), false);
  });

  it("maps every service failure to its exact redacted response", async () => {
    for (const [serviceCode, status, httpCode, retry] of [
      ["allocation-conflict", 409, "allocation-conflict", false],
      ["runner-unavailable", 409, "runner-unavailable", false],
      ["allocation-not-authorised", 403, "allocation-not-authorised", false],
      ["controller-unavailable", 503, "controller-unavailable", true],
      ["internal-error", 500, "internal-error", false],
    ] as const) {
      const handler = createAllocationHttpHandler({
        allocate: async () => {
          throw new AllocationServiceError(serviceCode);
        },
      });
      const response = await handler(validRequest());
      assert.equal(response.status, status);
      assert.equal(response.body, JSON.stringify({ error: httpCode }));
      assert.equal(response.headers["Retry-After"], retry ? "5" : undefined);
      assertSafetyHeaders(response.headers);
    }
  });
});

function validRequest(overrides: Partial<AllocationHttpRequest> = {}): AllocationHttpRequest {
  return {
    body: requestBody(),
    headers: validHeaders(),
    method: "POST",
    url: "/api/v1/allocations",
    ...overrides,
  };
}

function validHeaders(): readonly (readonly [string, string])[] {
  return [
    ["Content-Type", "application/json"],
    ["Authorization", "Bearer entra-access-token"],
    ["X-MS-CLIENT-PRINCIPAL", "mapped-principal"],
    ["X-Switchyard-GitHub-OIDC", "fresh.github.proof"],
  ];
}

function withoutHeader(headers: readonly (readonly [string, string])[], name: string) {
  return headers.filter(([key]) => key.toLowerCase() !== name.toLowerCase());
}

function replaceHeader(
  headers: readonly (readonly [string, string])[],
  name: string,
  value: string,
) {
  return [...withoutHeader(headers, name), [name, value] as const];
}

function assertSafetyHeaders(headers: Readonly<Record<string, string>>) {
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
}
