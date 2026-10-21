import { ContractValidationError } from "./validation.js";

export const BACKUP_CHOICES = ["Keep going", "Save money"] as const;

export type BackupChoice = (typeof BACKUP_CHOICES)[number];

export const DEFAULT_BACKUP_CHOICE: BackupChoice = "Keep going";

export function isBackupChoice(value: unknown): value is BackupChoice {
  return typeof value === "string" && BACKUP_CHOICES.some((choice) => choice === value);
}

export function parseBackupChoice(value: unknown, path = "backupChoice"): BackupChoice {
  if (!isBackupChoice(value)) {
    throw new ContractValidationError(
      path,
      `must be one of ${BACKUP_CHOICES.map((choice) => `'${choice}'`).join(", ")}`,
    );
  }

  return value;
}
