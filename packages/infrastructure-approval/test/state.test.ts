import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCanonicalInitialState,
  requireCanonicalInitialState,
  sha256Bytes,
  stateIdentityFromOpenTofuState,
} from "../src/index.js";
import { bytes, LINEAGE } from "./fixtures.js";

describe("canonical OpenTofu 1.12.1 initial state", () => {
  it("creates exact serial-zero empty state with one lowercase UUID lineage", () => {
    const first = createCanonicalInitialState();
    const second = createCanonicalInitialState();
    assert.match(first.lineage, /^[0-9a-f-]{36}$/);
    assert.notEqual(first.lineage, second.lineage);
    assert.equal(first.sha256, sha256Bytes(first.bytes));
    assert.deepEqual(requireCanonicalInitialState(first.bytes), first);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(first.bytes)), {
      version: 4,
      terraform_version: "1.12.1",
      serial: 0,
      lineage: first.lineage,
      outputs: {},
      resources: [],
      check_results: null,
    });
  });

  it("rejects non-canonical, nonzero, output-bearing and resource-bearing initial state", () => {
    const base = {
      version: 4,
      terraform_version: "1.12.1",
      serial: 0,
      lineage: LINEAGE,
      outputs: {},
      resources: [],
      check_results: null,
    };
    for (const value of [
      { ...base, serial: 1 },
      { ...base, outputs: { unsafe: { value: true } } },
      { ...base, resources: [{ mode: "managed" }] },
      { ...base, terraform_version: "1.12.0" },
    ]) {
      assert.throws(() => requireCanonicalInitialState(bytes(`${JSON.stringify(value)}\n`)));
    }
    assert.throws(() => requireCanonicalInitialState(bytes(`${JSON.stringify(base, null, 2)}\n`)));
  });

  it("derives the raw blob SHA-256 and exact ETag independently of state contents", () => {
    const state = createCanonicalInitialState(LINEAGE);
    assert.deepEqual(stateIdentityFromOpenTofuState(state.bytes, '"etag-1"'), {
      backendStateDigest: state.sha256,
      backendStateEtag: '"etag-1"',
      lineage: LINEAGE,
      managedResourceCount: 0,
      managedResourcesEmpty: true,
      serial: 0,
    });
  });
});
