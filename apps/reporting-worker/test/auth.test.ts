import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  AccessJwksCache,
  AccessJwtError,
  validateAccessJwt,
  validateAccessRequest,
} from "../src/auth.js";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "switchyard-reporting-audience";
const NOW = new Date("2026-08-25T12:00:00.000Z");

let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string };

before(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "access-key-1",
    alg: "RS256",
    use: "sig",
  };
});

describe("Cloudflare Access JWT boundary", () => {
  it("cryptographically validates the Access issuer, audience, lifetime and RS256 signature", async () => {
    let requestedUrl = "";
    const token = await accessToken();
    await validateAccessJwt(
      token,
      { issuer: ISSUER, audience: AUDIENCE },
      {
        now: NOW,
        cache: new AccessJwksCache(),
        fetch: async (input) => {
          requestedUrl = String(input);
          return Response.json({ keys: [publicJwk] });
        },
      },
    );

    assert.equal(requestedUrl, `${ISSUER}/cdn-cgi/access/certs`);
  });

  it("requires the signed assertion header on every request", async () => {
    await assert.rejects(
      () =>
        validateAccessRequest(
          new Request("https://reporting.example.test/v1/reports/7"),
          { issuer: ISSUER, audience: AUDIENCE },
          dependencies(),
        ),
      AccessJwtError,
    );

    const request = new Request("https://reporting.example.test/v1/reports/7", {
      headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
    });
    await validateAccessRequest(request, { issuer: ISSUER, audience: AUDIENCE }, dependencies());
  });

  it("fails closed for malformed, unsigned, tampered and unknown-key tokens", async () => {
    const valid = await accessToken();
    const [header, claims, signature] = valid.split(".") as [string, string, string];
    const tamperedClaims = encodeJson({
      ...baseClaims(),
      aud: ["attacker-audience"],
    });

    for (const token of [
      "",
      "not-a-jwt",
      `${header}.${claims}.not+base64url`,
      `${header}.${tamperedClaims}.${signature}`,
      await accessToken({}, { kid: "unknown" }),
      await accessToken({}, { alg: "none" }),
      await accessToken({}, { extra: "unsupported" }),
    ]) {
      await assert.rejects(
        () => validateAccessJwt(token, { issuer: ISSUER, audience: AUDIENCE }, dependencies()),
        AccessJwtError,
      );
    }
  });

  it("fails closed for issuer, audience and time claim mismatches", async () => {
    const nowSeconds = Math.floor(NOW.getTime() / 1_000);
    for (const claims of [
      { iss: "https://other.cloudflareaccess.com" },
      { aud: ["other-audience"] },
      { exp: nowSeconds - 31 },
      { iat: nowSeconds + 31 },
      { nbf: nowSeconds + 31 },
      { type: "org" },
      { exp: "not-a-number" },
      { aud: AUDIENCE },
    ]) {
      const token = await accessToken(claims);
      await assert.rejects(
        () => validateAccessJwt(token, { issuer: ISSUER, audience: AUDIENCE }, dependencies()),
        AccessJwtError,
      );
    }
  });

  it("fails closed when configuration or the JWKS endpoint is unavailable or malformed", async () => {
    const token = await accessToken();
    for (const issuer of [
      "http://example.cloudflareaccess.com",
      "https://example.com",
      `${ISSUER}/path`,
    ]) {
      await assert.rejects(
        () => validateAccessJwt(token, { issuer, audience: AUDIENCE }, dependencies()),
        AccessJwtError,
      );
    }

    await assert.rejects(
      () => validateAccessJwt(token, { issuer: ISSUER, audience: "" }, dependencies()),
      AccessJwtError,
    );
    await assert.rejects(
      () =>
        validateAccessJwt(
          token,
          { issuer: ISSUER, audience: AUDIENCE },
          {
            now: NOW,
            cache: new AccessJwksCache(),
            fetch: async () => new Response(null, { status: 503 }),
          },
        ),
      AccessJwtError,
    );
    await assert.rejects(
      () =>
        validateAccessJwt(
          token,
          { issuer: ISSUER, audience: AUDIENCE },
          {
            now: NOW,
            cache: new AccessJwksCache(),
            fetch: async () => Response.json({ keys: [] }),
          },
        ),
      AccessJwtError,
    );
  });

  it("uses a bounded JWKS cache without weakening signature checks", async () => {
    let requests = 0;
    const cache = new AccessJwksCache();
    const fetchJwks = async (): Promise<Response> => {
      requests += 1;
      return Response.json({ keys: [publicJwk] });
    };
    const token = await accessToken();

    await validateAccessJwt(
      token,
      { issuer: ISSUER, audience: AUDIENCE },
      {
        now: NOW,
        cache,
        fetch: fetchJwks,
      },
    );
    await validateAccessJwt(
      token,
      { issuer: ISSUER, audience: AUDIENCE },
      {
        now: new Date(NOW.getTime() + 60_000),
        cache,
        fetch: fetchJwks,
      },
    );
    assert.equal(requests, 1);
  });
});

function dependencies() {
  return {
    now: NOW,
    cache: new AccessJwksCache(),
    fetch: async () => Response.json({ keys: [publicJwk] }),
  };
}

function baseClaims(): Record<string, unknown> {
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);
  return {
    type: "app",
    aud: [AUDIENCE],
    exp: nowSeconds + 300,
    iss: ISSUER,
    iat: nowSeconds - 10,
    sub: "",
    common_name: "service-token.access",
  };
}

async function accessToken(
  claimOverrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = encodeJson({ alg: "RS256", kid: "access-key-1", typ: "JWT", ...headerOverrides });
  const claims = encodeJson({ ...baseClaims(), ...claimOverrides });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${encodeBytes(new Uint8Array(signature))}`;
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
