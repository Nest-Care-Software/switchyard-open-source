import { DEFAULT_BACKUP_CHOICE, parseBackupChoice, type BackupChoice } from "./backup-choice.js";
import { parseCapabilityProfile, type CapabilityProfile } from "./capabilities.js";
import {
  ContractValidationError,
  requireAllowedKeys,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
} from "./validation.js";

const WORKFLOW_INPUT_KEYS = ["profile", "backupChoice"] as const;
const WORKFLOW_OUTPUT_KEYS = ["runner_label", "allocation_id"] as const;

export interface WorkflowInputs {
  readonly backupChoice: BackupChoice;
  readonly profile: CapabilityProfile;
}

export interface WorkflowOutputs {
  readonly allocation_id: string;
  readonly runner_label: string;
}

export function parseWorkflowInputs(value: unknown): WorkflowInputs {
  const record = requireRecord(value, "workflowInputs");
  requireAllowedKeys(record, WORKFLOW_INPUT_KEYS, "workflowInputs");

  if (!Object.hasOwn(record, "profile")) {
    throw new ContractValidationError("workflowInputs.profile", "is required");
  }

  return {
    profile: parseCapabilityProfile(record.profile, "workflowInputs.profile"),
    backupChoice: Object.hasOwn(record, "backupChoice")
      ? parseBackupChoice(record.backupChoice, "workflowInputs.backupChoice")
      : DEFAULT_BACKUP_CHOICE,
  };
}

export function parseWorkflowOutputs(value: unknown): WorkflowOutputs {
  const record = requireRecord(value, "workflowOutputs");
  requireExactKeys(record, WORKFLOW_OUTPUT_KEYS, "workflowOutputs");

  if (!("runner_label" in record)) {
    throw new ContractValidationError("workflowOutputs.runner_label", "is required");
  }
  if (!("allocation_id" in record)) {
    throw new ContractValidationError("workflowOutputs.allocation_id", "is required");
  }

  return {
    runner_label: requireNonEmptyString(record.runner_label, "workflowOutputs.runner_label"),
    allocation_id: requireNonEmptyString(record.allocation_id, "workflowOutputs.allocation_id"),
  };
}
