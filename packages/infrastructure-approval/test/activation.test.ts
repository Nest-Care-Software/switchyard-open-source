import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  DISABLED_ENGINE_SHA,
  parseActivationConfiguration,
  requireCommittedActivationConfiguration,
} from "../src/index.js";
import { ACTIVATION_BYTES, bytes, POLICY, textOf } from "./fixtures.js";

describe("strict infrastructure activation configuration", () => {
  it("parses the exact committed synthetic foundation fixture", () => {
    const activation = parseActivationConfiguration(
      readFileSync("../../infra/foundation/activation.json"),
    );
    assert.equal(
      activation.digest,
      "cd314027b373b032cb33aefff924469afbaac068ee3e9fc9f9fedac32cdc38b2",
    );
    assert.equal(activation.finalEngineSha, "5c9b286fcb5761a3fcf4b4c87882ec56103333e7");
    assert.equal(activation.policy.plannerIdentityClientId, "a0000000-0000-4000-8000-000000000004");
    assert.equal(
      activation.policy.foundationIdentityPrincipalId,
      "a0000000-0000-4000-8000-000000000007",
    );
    assert.equal(
      activation.policy.bootstrapIdentityPrincipalId,
      "a0000000-0000-4000-8000-000000000009",
    );
  });

  it("parses the exact canonical non-secret fixture", () => {
    const activation = parseActivationConfiguration(ACTIVATION_BYTES);
    assert.equal(activation.digest, POLICY.activationConfigDigest);
    assert.deepEqual(activation.policy, POLICY);
  });

  for (const [name, transform] of [
    ["missing field", (source: string) => source.replace(/,"foundation":\{[^}]+\}/, "")],
    ["extra field", (source: string) => source.replace(/}\n$/, ',"extra":true}\n')],
    [
      "wrong tenant",
      (source: string) => source.replace(POLICY.tenantId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    ],
    [
      "disabled engine SHA",
      (source: string) => source.replace(POLICY.planEngineSha, DISABLED_ENGINE_SHA),
    ],
    [
      "uppercase UUID",
      (source: string) =>
        source.replace(POLICY.subscriptionId, POLICY.subscriptionId.toUpperCase()),
    ],
    [
      "secret-like value",
      (source: string) => source.replace(/}\n$/, ',"client_secret":"do-not-store"}\n'),
    ],
    ["non-canonical whitespace", (source: string) => ` ${source}`],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.throws(() => parseActivationConfiguration(bytes(transform(textOf(ACTIVATION_BYTES)))));
    });
  }

  it("rejects a policy whose non-digest authority tuple differs from the committed file", () => {
    assert.throws(
      () =>
        requireCommittedActivationConfiguration(
          { ...POLICY, foundationIdentityClientId: "77777777-7777-7777-7777-777777777777" },
          ACTIVATION_BYTES,
        ),
      /committed-activation-configuration-mismatch/,
    );
  });
});
