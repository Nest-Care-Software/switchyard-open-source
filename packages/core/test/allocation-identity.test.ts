import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allocationIdForIdentity,
  allocationIdempotencyKey,
  MAX_GITHUB_ID_DIGITS,
  parseAllocationIdentity,
  type AllocationIdentity,
} from "../src/index.js";

const IDENTITY: AllocationIdentity = {
  repository_id: "987654321",
  run_id: "12345678901234567890",
  run_attempt: 1,
  allocator_check_run_id: "555000111",
};

describe("allocation identity", () => {
  it("validates the exact GitHub idempotency identity", () => {
    assert.deepEqual(parseAllocationIdentity(IDENTITY), IDENTITY);
  });

  it("builds a deterministic key", () => {
    assert.equal(allocationIdempotencyKey(IDENTITY), allocationIdempotencyKey({ ...IDENTITY }));
  });

  it("distinguishes multiple allocations in one workflow run", () => {
    const firstAllocation = allocationIdempotencyKey(IDENTITY);
    const secondAllocation = allocationIdempotencyKey({
      ...IDENTITY,
      allocator_check_run_id: "555000112",
    });

    assert.notEqual(firstAllocation, secondAllocation);
  });

  it("distinguishes reruns of the same workflow run", () => {
    const firstAttempt = allocationIdempotencyKey(IDENTITY);
    const rerun = allocationIdempotencyKey({
      ...IDENTITY,
      run_attempt: 2,
    });

    assert.notEqual(firstAttempt, rerun);
  });

  it("changes the key when the repository or run changes", () => {
    const original = allocationIdempotencyKey(IDENTITY);

    assert.notEqual(
      original,
      allocationIdempotencyKey({ ...IDENTITY, repository_id: "987654322" }),
    );
    assert.notEqual(original, allocationIdempotencyKey({ ...IDENTITY, run_id: "1234567891" }));
  });

  it("rejects malformed, legacy or incomplete identities", () => {
    assert.throws(
      () => parseAllocationIdentity({ ...IDENTITY, repository_id: "example-org/example-workload" }),
      /repository_id: must be a positive decimal string/,
    );
    assert.throws(
      () => parseAllocationIdentity({ ...IDENTITY, run_id: "12.3" }),
      /run_id: must be a positive decimal string/,
    );
    assert.throws(
      () => parseAllocationIdentity({ ...IDENTITY, run_attempt: 0 }),
      /run_attempt: must be a positive safe integer/,
    );
    assert.throws(
      () => parseAllocationIdentity({ ...IDENTITY, jobIdentity: "legacy-field" }),
      /contains unsupported field 'jobIdentity'/,
    );
  });

  it("requires own data fields and accepts null-prototype transport objects", () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, IDENTITY);
    assert.deepEqual(parseAllocationIdentity(nullPrototype), IDENTITY);
    assert.throws(() => parseAllocationIdentity(Object.create(IDENTITY)), /ordinary|own data/);

    let getterCalled = false;
    const accessor = { ...IDENTITY } as Record<string, unknown>;
    Object.defineProperty(accessor, "run_id", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return IDENTITY.run_id;
      },
    });
    assert.throws(() => parseAllocationIdentity(accessor), /own data property/);
    assert.equal(getterCalled, false);
  });

  it("hashes boundary identities into bounded Azure-safe allocation keys", () => {
    const boundaryIdentity: AllocationIdentity = {
      allocator_check_run_id: "9".repeat(MAX_GITHUB_ID_DIGITS),
      repository_id: "8".repeat(MAX_GITHUB_ID_DIGITS),
      run_attempt: Number.MAX_SAFE_INTEGER,
      run_id: "7".repeat(MAX_GITHUB_ID_DIGITS),
    };
    const allocationId = allocationIdForIdentity(boundaryIdentity);

    assert.match(allocationId, /^sy1-[0-9a-f]{64}$/);
    assert.ok(`generation!${allocationId}!01`.length < 1024);
    assert.equal(allocationIdForIdentity({ ...boundaryIdentity }), allocationId);
    assert.throws(
      () =>
        allocationIdForIdentity({
          ...boundaryIdentity,
          run_id: "7".repeat(MAX_GITHUB_ID_DIGITS + 1),
        }),
      /at most 64 decimal digits/,
    );
  });
});
