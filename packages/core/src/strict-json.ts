import { ContractValidationError, requireExactKeys, requireRecord } from "./validation.js";

export interface StrictJsonOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

export interface StrictJsonObjectOptions extends StrictJsonOptions {
  readonly path?: string;
}

export const DEFAULT_STRICT_JSON_MAX_BYTES = 64 * 1024;
export const MAX_STRICT_JSON_MAX_BYTES = 1024 * 1024;

/** Returns as soon as a string is known to exceed a UTF-8 byte limit, without encoding a copy. */
export function exceedsUtf8ByteLimit(source: string, maxBytes: number): boolean {
  if (source.length > maxBytes) {
    return true;
  }

  let bytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < source.length &&
      source.charCodeAt(index + 1) >= 0xdc00 &&
      source.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      // TextEncoder replaces an unpaired surrogate with the three-byte U+FFFD sequence.
      bytes += 3;
    }
    if (bytes > maxBytes) {
      return true;
    }
  }
  return false;
}

/** Parses size-bounded JSON while rejecting duplicate object keys and excessive nesting. */
export function parseStrictJson(source: string, options: StrictJsonOptions = {}): unknown {
  if (typeof source !== "string") {
    throw new ContractValidationError("json", "must be text");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_STRICT_JSON_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STRICT_JSON_MAX_BYTES) {
    throw new ContractValidationError(
      "json.maxBytes",
      `must be an integer from 1 to ${MAX_STRICT_JSON_MAX_BYTES}`,
    );
  }
  if (exceedsUtf8ByteLimit(source, maxBytes)) {
    throw new ContractValidationError("json", `exceeds the ${maxBytes}-byte limit`);
  }
  const parser = new StrictJsonParser(source, options.maxDepth ?? 64);
  return parser.parse();
}

/** Parses one JSON object and requires exactly the named top-level keys. */
export function parseStrictJsonObject(
  source: string,
  allowedKeys: readonly string[],
  options: StrictJsonObjectOptions = {},
): Record<string, unknown> {
  const path = options.path ?? "json";
  if (
    allowedKeys.some((key) => typeof key !== "string" || key.length === 0) ||
    new Set(allowedKeys).size !== allowedKeys.length
  ) {
    throw new ContractValidationError(`${path}.allowedKeys`, "must contain unique non-empty keys");
  }
  const record = requireRecord(parseStrictJson(source, options), path);
  requireExactKeys(record, allowedKeys, path);
  return record;
}

class StrictJsonParser {
  readonly #maxDepth: number;
  readonly #source: string;
  #position = 0;

  constructor(source: string, maxDepth: number) {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) {
      throw new ContractValidationError("json.maxDepth", "must be an integer from 1 to 256");
    }
    this.#source = source;
    this.#maxDepth = maxDepth;
  }

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#position !== this.#source.length) {
      this.#invalid("contains trailing data");
    }
    return value;
  }

  #parseValue(depth: number): unknown {
    if (depth > this.#maxDepth) {
      this.#invalid("exceeds the maximum nesting depth");
    }
    const character = this.#source[this.#position];
    if (character === "{") {
      if (depth >= this.#maxDepth) {
        this.#invalid("exceeds the maximum nesting depth");
      }
      return this.#parseObject(depth + 1);
    }
    if (character === "[") {
      if (depth >= this.#maxDepth) {
        this.#invalid("exceeds the maximum nesting depth");
      }
      return this.#parseArray(depth + 1);
    }
    if (character === '"') {
      return this.#parseString();
    }
    if (character === "t") {
      return this.#parseLiteral("true", true);
    }
    if (character === "f") {
      return this.#parseLiteral("false", false);
    }
    if (character === "n") {
      return this.#parseLiteral("null", null);
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      return this.#parseNumber();
    }
    this.#invalid("contains an unexpected token");
  }

  #parseObject(depth: number): Record<string, unknown> {
    this.#position += 1;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#source[this.#position] === "}") {
      this.#position += 1;
      return result;
    }

    while (this.#position < this.#source.length) {
      if (this.#source[this.#position] !== '"') {
        this.#invalid("requires quoted object keys");
      }
      const key = this.#parseString();
      if (keys.has(key)) {
        this.#invalid(`contains duplicate object key '${safeKey(key)}'`);
      }
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      this.#skipWhitespace();
      result[key] = this.#parseValue(depth);
      this.#skipWhitespace();
      const separator = this.#source[this.#position];
      if (separator === "}") {
        this.#position += 1;
        return result;
      }
      this.#expect(",");
      this.#skipWhitespace();
    }
    this.#invalid("contains an unterminated object");
  }

  #parseArray(depth: number): unknown[] {
    this.#position += 1;
    const result: unknown[] = [];
    this.#skipWhitespace();
    if (this.#source[this.#position] === "]") {
      this.#position += 1;
      return result;
    }
    while (this.#position < this.#source.length) {
      result.push(this.#parseValue(depth));
      this.#skipWhitespace();
      const separator = this.#source[this.#position];
      if (separator === "]") {
        this.#position += 1;
        return result;
      }
      this.#expect(",");
      this.#skipWhitespace();
    }
    this.#invalid("contains an unterminated array");
  }

  #parseString(): string {
    const start = this.#position;
    this.#position += 1;
    while (this.#position < this.#source.length) {
      const character = this.#source[this.#position];
      if (character === '"') {
        this.#position += 1;
        const encoded = this.#source.slice(start, this.#position);
        try {
          const value: unknown = JSON.parse(encoded);
          if (typeof value !== "string") {
            this.#invalid("contains an invalid string");
          }
          return value;
        } catch {
          this.#invalid("contains an invalid string escape");
        }
      }
      if (character === "\\") {
        this.#position += 2;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.#invalid("contains an invalid string character");
      }
      this.#position += 1;
    }
    this.#invalid("contains an unterminated string");
  }

  #parseNumber(): number {
    const start = this.#position;
    if (this.#source[this.#position] === "-") {
      this.#position += 1;
    }

    if (this.#source[this.#position] === "0") {
      this.#position += 1;
    } else {
      const firstIntegerDigit = this.#source[this.#position];
      if (firstIntegerDigit === undefined || firstIntegerDigit < "1" || firstIntegerDigit > "9") {
        this.#invalid("contains an invalid number");
      }
      this.#consumeDigits();
    }

    if (this.#source[this.#position] === ".") {
      this.#position += 1;
      if (!this.#isDigit(this.#source[this.#position])) {
        this.#invalid("contains an invalid number");
      }
      this.#consumeDigits();
    }

    const exponent = this.#source[this.#position];
    if (exponent === "e" || exponent === "E") {
      this.#position += 1;
      const sign = this.#source[this.#position];
      if (sign === "+" || sign === "-") {
        this.#position += 1;
      }
      if (!this.#isDigit(this.#source[this.#position])) {
        this.#invalid("contains an invalid number");
      }
      this.#consumeDigits();
    }

    const value = Number(this.#source.slice(start, this.#position));
    if (!Number.isFinite(value)) {
      this.#invalid("contains a non-finite number");
    }
    return value;
  }

  #consumeDigits(): void {
    while (this.#isDigit(this.#source[this.#position])) {
      this.#position += 1;
    }
  }

  #isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "0" && value <= "9";
  }

  #parseLiteral<T>(literal: string, value: T): T {
    if (!this.#source.startsWith(literal, this.#position)) {
      this.#invalid("contains an invalid literal");
    }
    this.#position += literal.length;
    return value;
  }

  #expect(expected: string): void {
    if (this.#source[this.#position] !== expected) {
      this.#invalid(`expected '${expected}'`);
    }
    this.#position += 1;
  }

  #skipWhitespace(): void {
    while (
      this.#position < this.#source.length &&
      (this.#source[this.#position] === " " ||
        this.#source[this.#position] === "\t" ||
        this.#source[this.#position] === "\n" ||
        this.#source[this.#position] === "\r")
    ) {
      this.#position += 1;
    }
  }

  #invalid(message: string): never {
    throw new ContractValidationError(
      "json",
      `${message} at UTF-16 code-unit offset ${this.#position}`,
    );
  }
}

function safeKey(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}
