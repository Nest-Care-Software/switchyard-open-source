export class ContractValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
    this.path = path;
  }
}

export function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractValidationError(path, "must be an object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractValidationError(path, "must be an ordinary or null-prototype object");
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ContractValidationError(propertyPath(path, key), "must be an own data property");
    }
  }

  return value as Record<string, unknown>;
}

export function requireAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKey = Reflect.ownKeys(value).find(
    (key) => typeof key !== "string" || !allowed.has(key),
  );
  if (unknownKey !== undefined) {
    throw new ContractValidationError(
      path,
      `contains unsupported field '${safePropertyName(unknownKey)}'`,
    );
  }
}

export function requireExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  path: string,
): void {
  requireAllowedKeys(value, requiredKeys, path);
  for (const key of requiredKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ContractValidationError(`${path}.${key}`, "is required as an own data property");
    }
  }
}

export function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractValidationError(path, "must be a non-empty string");
  }

  return value;
}

function propertyPath(path: string, key: string | symbol): string {
  return typeof key === "string" ? `${path}.${key}` : `${path}.[symbol]`;
}

function safePropertyName(key: string | symbol): string {
  if (typeof key === "symbol") {
    return "[symbol]";
  }
  return key.length <= 64 ? key : `${key.slice(0, 61)}...`;
}
