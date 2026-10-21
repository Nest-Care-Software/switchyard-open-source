import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_STRICT_JSON_MAX_BYTES,
  exceedsUtf8ByteLimit,
  parseStrictJson,
  parseStrictJsonObject,
} from "../src/index.js";

describe("strict JSON parsing", () => {
  it("parses ordinary JSON without giving special object keys prototypes", () => {
    const value = parseStrictJson('{"nested":{"value":1},"array":[true,null,"x"]}');
    assert.deepEqual(structuredClone(value), {
      nested: { value: 1 },
      array: [true, null, "x"],
    });
    assert.equal(Object.getPrototypeOf(value as object), null);
  });

  it("rejects duplicate keys at every depth", () => {
    for (const value of [
      '{"aud":"one","aud":"two"}',
      '{"outer":{"kid":"a","kid":"b"}}',
      '{"a":1,"\\u0061":2}',
    ]) {
      assert.throws(() => parseStrictJson(value), /duplicate object key/);
    }
  });

  it("rejects unknown root keys against an exact allowlist", () => {
    assert.deepEqual(
      structuredClone(parseStrictJsonObject('{"iss":"trusted","aud":"api"}', ["iss", "aud"])),
      { iss: "trusted", aud: "api" },
    );
    assert.throws(
      () => parseStrictJsonObject('{"iss":"trusted","aud":"api","admin":true}', ["iss", "aud"]),
      /unsupported field 'admin'/,
    );
    assert.throws(() => parseStrictJsonObject("[]", ["iss"]), /must be an object/);
  });

  it("rejects malformed, trailing and excessively nested JSON", () => {
    for (const value of ["", "{} trailing", '{"x":}', "[1,]", '"unterminated', "{\u00a0}"]) {
      assert.throws(() => parseStrictJson(value));
    }
    assert.throws(() => parseStrictJson("[[[]]]", { maxDepth: 2 }), /nesting depth/);
    assert.deepEqual(parseStrictJson("[[]]", { maxDepth: 2 }), [[]]);
    assert.throws(() => parseStrictJson("{}", { maxDepth: 0 }), /integer from 1 to 256/);
    assert.throws(() => parseStrictJson("{}", { maxDepth: 257 }), /integer from 1 to 256/);
    assert.deepEqual(structuredClone(parseStrictJson('{"empty":{"nested":{}}}', { maxDepth: 3 })), {
      empty: { nested: {} },
    });
    assert.throws(
      () => parseStrictJson('{"empty":{"nested":{}}}', { maxDepth: 2 }),
      /nesting depth/,
    );
  });

  it("enforces intrinsic UTF-8 byte bounds at exact boundaries", () => {
    assert.equal(parseStrictJson('"é"', { maxBytes: 4 }), "é");
    assert.throws(() => parseStrictJson('"é"', { maxBytes: 3 }), /3-byte limit/);
    assert.equal(
      parseStrictJson(`"${"a".repeat(DEFAULT_STRICT_JSON_MAX_BYTES - 2)}"`),
      "a".repeat(DEFAULT_STRICT_JSON_MAX_BYTES - 2),
    );
    assert.throws(
      () => parseStrictJson(`"${"a".repeat(DEFAULT_STRICT_JSON_MAX_BYTES - 1)}"`),
      /byte limit/,
    );
    assert.throws(() => parseStrictJson("{}", { maxBytes: 0 }), /json.maxBytes/);
  });

  it("rejects many-megabyte input through the allocation-free length fast path", () => {
    const oversized = `"${"a".repeat(8 * 1024 * 1024)}"`;
    assert.equal(exceedsUtf8ByteLimit(oversized, DEFAULT_STRICT_JSON_MAX_BYTES), true);
    assert.throws(
      () => parseStrictJson(oversized),
      new RegExp(`${DEFAULT_STRICT_JSON_MAX_BYTES}-byte limit`),
    );
  });

  it("reports malformed multibyte JSON in UTF-16 code-unit offsets", () => {
    assert.throws(
      () => parseStrictJson('{"é":1}x'),
      /contains trailing data at UTF-16 code-unit offset 7/,
    );
  });

  it("scans large numeric arrays without copying the unparsed remainder", () => {
    const numbers = Array.from({ length: 20_000 }, (_, index) => index % 10);
    assert.deepEqual(parseStrictJson(JSON.stringify(numbers), { maxBytes: 64 * 1024 }), numbers);
  });
});
