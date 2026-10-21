import {
  ContractValidationError,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
} from "./validation.js";

const ALLOCATION_IDENTITY_KEYS = [
  "repository_id",
  "run_id",
  "run_attempt",
  "allocator_check_run_id",
] as const;

export const MAX_GITHUB_ID_DIGITS = 64;

export interface AllocationIdentity {
  readonly allocator_check_run_id: string;
  readonly repository_id: string;
  readonly run_attempt: number;
  readonly run_id: string;
}

export function parseAllocationIdentity(value: unknown): AllocationIdentity {
  const record = requireRecord(value, "allocationIdentity");
  requireExactKeys(record, ALLOCATION_IDENTITY_KEYS, "allocationIdentity");

  const repository_id = parseNumericGitHubId(
    record.repository_id,
    "allocationIdentity.repository_id",
  );
  const run_id = parseNumericGitHubId(record.run_id, "allocationIdentity.run_id");
  const allocator_check_run_id = parseNumericGitHubId(
    record.allocator_check_run_id,
    "allocationIdentity.allocator_check_run_id",
  );

  const run_attempt = record.run_attempt;
  if (!Number.isSafeInteger(run_attempt) || (run_attempt as number) < 1) {
    throw new ContractValidationError(
      "allocationIdentity.run_attempt",
      "must be a positive safe integer",
    );
  }

  return {
    repository_id,
    run_id,
    run_attempt: run_attempt as number,
    allocator_check_run_id,
  };
}

export function allocationIdempotencyKey(identity: AllocationIdentity): string {
  const validated = parseAllocationIdentity(identity);
  const values = [
    validated.repository_id,
    validated.run_id,
    String(validated.run_attempt),
    validated.allocator_check_run_id,
  ];

  const encodedValues = values.map((value) => `${value.length}:${value}`).join("|");
  return `switchyard-allocation-v1|${encodedValues}`;
}

function parseNumericGitHubId(value: unknown, path: string): string {
  const identifier = requireNonEmptyString(value, path);
  if (!/^[1-9]\d*$/.test(identifier)) {
    throw new ContractValidationError(path, "must be a positive decimal string");
  }
  if (identifier.length > MAX_GITHUB_ID_DIGITS) {
    throw new ContractValidationError(
      path,
      `must contain at most ${MAX_GITHUB_ID_DIGITS} decimal digits`,
    );
  }

  return identifier;
}
