import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AZURE_MANAGEMENT_SCOPE,
  AZURE_STORAGE_SCOPE,
  LiveGitHubOidcEntraExchange,
  verifyIdentitySession,
} from "../src/index.js";
import { futureIdentityContracts } from "../src/contracts.js";
import { APPLY_ENGINE_SHA, POLICY, RAW_APPLY_TOKEN } from "./fixtures.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const SECRET_ACCESS_TOKEN = "secret-access-token-that-must-never-appear";
const OPAQUE_ACCESS_TOKEN = "opaque~managed.identity+token/for_Azure-resources";

describe("exact live Entra client assertion exchange", () => {
  it("exchanges the same assertion for exact management and storage bearer sessions", async () => {
    const forms: URLSearchParams[] = [];
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async (input, init) => {
        assert.equal(
          String(input),
          `https://login.microsoftonline.com/${POLICY.tenantId}/oauth2/v2.0/token`,
        );
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        const form = new URLSearchParams(Buffer.from(init.body as Buffer).toString("utf8"));
        forms.push(form);
        return tokenResponse();
      },
      now: () => NOW,
    });
    const rawToken = Uint8Array.from(RAW_APPLY_TOKEN);
    const session = await exchange.exchangeExactToken(exchangeInput(rawToken));
    verifyIdentitySession(session, "foundation-applier", POLICY, session.assertionDigest);
    assert.deepEqual(
      forms.map((form) => form.get("scope")),
      [AZURE_MANAGEMENT_SCOPE, AZURE_STORAGE_SCOPE],
    );
    assert.ok(
      forms.every((form) => form.get("client_assertion") === new TextDecoder().decode(rawToken)),
    );
    assert.ok(forms.every((form) => form.get("client_id") === POLICY.foundationIdentityClientId));
    assert.equal(
      (await session.credential.getToken(AZURE_MANAGEMENT_SCOPE))?.token.length !== 0,
      true,
    );
    assert.equal(
      (await session.credential.getToken(AZURE_STORAGE_SCOPE))?.token.length !== 0,
      true,
    );
    assert.equal(await session.credential.getToken("https://vault.azure.net/.default"), null);
  });

  it("accepts Entra's live canonical decimal-string token lifetimes", async () => {
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async (_input, init) => {
        assert.ok(init.body instanceof Uint8Array);
        return tokenResponse({ expires_in: "3599", ext_expires_in: "3599" });
      },
      now: () => NOW,
    });

    const session = await exchange.exchangeExactToken(
      exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN)),
    );
    assert.notEqual(await session.credential.getToken(AZURE_MANAGEMENT_SCOPE), null);
    assert.notEqual(await session.credential.getToken(AZURE_STORAGE_SCOPE), null);
  });

  it("accepts documented 24-hour managed-identity tokens but bounds session credential use", async () => {
    let now = NOW;
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async (_input, init) => {
        assert.ok(init.body instanceof Uint8Array);
        return tokenResponse({ expires_in: "86400", ext_expires_in: "86400" });
      },
      now: () => now,
    });

    const session = await exchange.exchangeExactToken(
      exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN)),
    );
    const token = await session.credential.getToken(AZURE_MANAGEMENT_SCOPE);
    assert.equal(token?.expiresOnTimestamp, NOW + 45 * 60 * 1_000);
    now = NOW + (45 * 60 - 31) * 1_000;
    assert.notEqual(await session.credential.getToken(AZURE_MANAGEMENT_SCOPE), null);
    now += 1_000;
    assert.equal(await session.credential.getToken(AZURE_MANAGEMENT_SCOPE), null);
  });

  it("rejects non-canonical or out-of-range string lifetimes without leaking response material", async () => {
    for (const value of [
      "",
      "0",
      "59",
      "86401",
      "100000",
      "03600",
      "086400",
      "+3600",
      "-3600",
      " 3600",
      "3600 ",
      "3600.0",
      "3.6e3",
    ]) {
      for (const field of ["expires_in", "ext_expires_in"] as const) {
        const exchange = new LiveGitHubOidcEntraExchange({
          fetch: async () => tokenResponse({ [field]: value }),
          now: () => NOW,
        });
        await assert.rejects(
          () => exchange.exchangeExactToken(exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN))),
          (error: unknown) =>
            error instanceof Error &&
            error.message === `entra-token-${field}-invalid` &&
            !error.message.includes(SECRET_ACCESS_TOKEN),
        );
      }
    }
  });

  it("treats Microsoft-owned API access tokens as bounded opaque credentials", async () => {
    const opaqueTokens = [
      OPAQUE_ACCESS_TOKEN,
      `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(
        JSON.stringify({ xms_mirid: "Microsoft-owned opaque claim" }),
      ).toString("base64url")}.signature`,
    ];
    let response = 0;
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async () => tokenResponse({ access_token: opaqueTokens[response++] }),
      now: () => NOW,
    });

    const session = await exchange.exchangeExactToken(
      exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN)),
    );
    assert.equal(
      (await session.credential.getToken(AZURE_MANAGEMENT_SCOPE))?.token,
      opaqueTokens[0],
    );
    assert.equal((await session.credential.getToken(AZURE_STORAGE_SCOPE))?.token, opaqueTokens[1]);
  });

  it("rejects malformed or oversized opaque bearer values without exposing them", async () => {
    for (const value of [
      "",
      "too-short",
      "contains whitespace in an otherwise long token",
      `contains-newline${"a".repeat(32)}\n`,
      `unsupported-dollar${"a".repeat(32)}$`,
      "a".repeat(16 * 1024 + 1),
    ]) {
      const exchange = new LiveGitHubOidcEntraExchange({
        fetch: async () => tokenResponse({ access_token: value }),
        now: () => NOW,
      });
      await assert.rejects(
        () => exchange.exchangeExactToken(exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN))),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "entra-access-token-invalid" &&
          (value.length === 0 || !error.message.includes(value)),
      );
    }
  });

  for (const [name, response] of [
    ["wrong token type", tokenResponse({ token_type: "Basic" })],
    ["unsafe expiry", tokenResponse({ expires_in: 30 })],
  ] as const) {
    it(`rejects ${name} without leaking response material`, async () => {
      const exchange = new LiveGitHubOidcEntraExchange({
        fetch: async () => response.clone(),
        now: () => NOW,
      });
      await assert.rejects(
        () => exchange.exchangeExactToken(exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN))),
        (error: unknown) => error instanceof Error && !error.message.includes(SECRET_ACCESS_TOKEN),
      );
    });
  }

  it("classifies strict token response contract errors without leaking response material", async () => {
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async () =>
        new Response(
          `{"token_type":"Bearer","token_type":"Bearer","expires_in":3600,"ext_expires_in":3600,"access_token":"${SECRET_ACCESS_TOKEN}"}`,
          { status: 200 },
        ),
      now: () => NOW,
    });
    await assert.rejects(
      () => exchange.exchangeExactToken(exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN))),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "entra-token-response-invalid" &&
        !error.message.includes(SECRET_ACCESS_TOKEN),
    );
  });

  it("detects changed assertion bytes between the first exchange and session creation", async () => {
    const rawToken = Uint8Array.from(RAW_APPLY_TOKEN);
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async () => {
        rawToken[0] = (rawToken[0] ?? 0) ^ 1;
        return tokenResponse();
      },
      now: () => NOW,
    });
    await assert.rejects(
      () => exchange.exchangeExactToken(exchangeInput(rawToken)),
      /oidc-token-mutated/,
    );
  });

  it("redacts a non-success token response body", async () => {
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async () => new Response(SECRET_ACCESS_TOKEN, { status: 401 }),
      now: () => NOW,
    });
    await assert.rejects(
      () => exchange.exchangeExactToken(exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN))),
      (error: unknown) => error instanceof Error && error.message === "entra-token-status-401",
    );
  });

  it("rejects a truncated declared response without retaining its bytes", async () => {
    const exchange = new LiveGitHubOidcEntraExchange({
      fetch: async () => new Response("{}", { headers: { "content-length": "3" }, status: 200 }),
      now: () => NOW,
    });
    await assert.rejects(
      () => exchange.exchangeExactToken(exchangeInput(Uint8Array.from(RAW_APPLY_TOKEN))),
      /entra-token-response-truncated/,
    );
  });
});

function exchangeInput(rawToken: Uint8Array) {
  const contract = futureIdentityContracts(POLICY)["foundation-applier"];
  return {
    allowAmbientCredentials: false as const,
    audience: contract.audience,
    clientId: POLICY.foundationIdentityClientId,
    identity: "foundation-applier" as const,
    jobWorkflowRef: `example-org/switchyard/.github/workflows/infrastructure-apply-engine.yml@${APPLY_ENGINE_SHA}`,
    principalId: POLICY.foundationIdentityPrincipalId,
    rawToken,
    subject: contract.subject,
    subscriptionId: POLICY.subscriptionId,
    tenantId: POLICY.tenantId,
  };
}

function tokenResponse(responseOverrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      token_type: "Bearer",
      expires_in: 3600,
      ext_expires_in: 3600,
      access_token: OPAQUE_ACCESS_TOKEN,
      ...responseOverrides,
    }),
    { status: 200 },
  );
}
