import type { TokenCredential } from "@azure/core-auth";
import {
  TableClient,
  type TableEntity,
  type TableEntityResult,
  type TableTransactionResponse,
  type TransactionAction,
} from "@azure/data-tables";
import {
  AZURE_TABLE_LEDGER_PARTITION_KEY,
  AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  type AzureLedgerInstanceEvidence,
} from "@switchyard/azure-ledger";
import { AllocationLedgerError, type ProviderName } from "@switchyard/core";

const FOUNDATION_ROW_KEYS = [
  "bootstrap!ledger",
  "control!azure",
  "control!blacksmith",
  "heartbeat!reconciler",
] as const;
const SYSTEM_ENTITY_KEYS = ["etag", "partitionKey", "rowKey", "timestamp"] as const;

export interface AzureTableLedgerBootstrapOptions {
  readonly accountName: string;
  readonly provisioningCredential: TokenCredential;
  readonly tableName: string;
}

export interface AzureTableLedgerProvisioningPort {
  listEntities<T extends object = Record<string, unknown>>(): AsyncIterable<TableEntityResult<T>>;
  submitTransaction(actions: TransactionAction[]): Promise<TableTransactionResponse>;
}

export interface AzureTableLedgerProvisioningCapability {
  readonly kind: "switchyard-ledger-provisioning";
  readonly tableClient: AzureTableLedgerProvisioningPort;
}

export interface BootstrapAzureTableLedgerResult {
  readonly evidence: AzureLedgerInstanceEvidence;
  readonly outcome: "created" | "exact-race-recovery";
}

export function createAzureTableLedgerBootstrap(
  options: AzureTableLedgerBootstrapOptions,
): AzureTableLedgerBootstrap {
  const accountName = requireStorageAccountName(options.accountName);
  const tableName = requireTableName(options.tableName);
  if (
    typeof options.provisioningCredential !== "object" ||
    options.provisioningCredential === null ||
    typeof options.provisioningCredential.getToken !== "function"
  ) {
    throw invalid("provisioningCredential must be an explicitly supplied TokenCredential");
  }
  return new AzureTableLedgerBootstrap({
    kind: "switchyard-ledger-provisioning",
    tableClient: new TableClient(
      `https://${accountName}.table.core.windows.net`,
      tableName,
      options.provisioningCredential,
    ),
  });
}

export class AzureTableLedgerBootstrap {
  readonly #client: AzureTableLedgerProvisioningPort;

  constructor(capability: AzureTableLedgerProvisioningCapability) {
    if (
      typeof capability !== "object" ||
      capability === null ||
      capability.kind !== "switchyard-ledger-provisioning" ||
      typeof capability.tableClient !== "object" ||
      capability.tableClient === null ||
      typeof capability.tableClient.listEntities !== "function" ||
      typeof capability.tableClient.submitTransaction !== "function"
    ) {
      throw invalid("an explicit one-time ledger provisioning capability is required");
    }
    this.#client = capability.tableClient;
  }

  async bootstrap(
    suppliedEvidence: AzureLedgerInstanceEvidence,
  ): Promise<BootstrapAzureTableLedgerResult> {
    const evidence = validateEvidence(suppliedEvidence);
    const initialRows = await this.#scanEntireTable();
    if (initialRows.length !== 0) {
      throw new AllocationLedgerError(
        "precondition-failed",
        "ledger bootstrap requires an entirely empty target table",
      );
    }

    const actions = foundationEntities(evidence).map(
      (entity): TransactionAction => ["create", entity],
    );
    try {
      await this.#client.submitTransaction(actions);
      const committedRows = await this.#scanEntireTable();
      if (!matchesExactFoundation(committedRows, evidence)) {
        throw new AllocationLedgerError(
          "allocation-conflict",
          "the table changed during bootstrap and no longer contains only the exact foundation",
        );
      }
      return { evidence, outcome: "created" };
    } catch (error) {
      if (error instanceof AllocationLedgerError) {
        throw error;
      }
      const recoveredRows = await this.#scanEntireTable();
      if (matchesExactFoundation(recoveredRows, evidence)) {
        return { evidence, outcome: "exact-race-recovery" };
      }
      if (recoveredRows.length !== 0) {
        throw new AllocationLedgerError(
          "allocation-conflict",
          "a racing bootstrap persisted different evidence or unexpected rows",
          { cause: error },
        );
      }
      throw new AllocationLedgerError(
        "ledger-unavailable",
        "Azure Tables did not confirm the atomic ledger bootstrap",
        { cause: error },
      );
    }
  }

  async #scanEntireTable(): Promise<ReadonlyArray<TableEntityResult<Record<string, unknown>>>> {
    const rows: Array<TableEntityResult<Record<string, unknown>>> = [];
    try {
      for await (const entity of this.#client.listEntities<Record<string, unknown>>()) {
        rows.push(entity);
      }
      return rows;
    } catch (error) {
      throw new AllocationLedgerError(
        "ledger-unavailable",
        "Azure Tables could not prove that the bootstrap target is empty",
        { cause: error },
      );
    }
  }
}

function foundationEntities(
  evidence: AzureLedgerInstanceEvidence,
): ReadonlyArray<TableEntity<Record<string, unknown>>> {
  const registryDocument = {
    initialisedAt: evidence.initialisedAt,
    ledgerInstanceId: evidence.ledgerInstanceId,
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    schemaVersion: evidence.schemaVersion,
    utcDay: evidence.utcDay,
  };
  return [
    {
      partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
      rowKey: FOUNDATION_ROW_KEYS[0],
      document: JSON.stringify(registryDocument),
      entityType: "bootstrap-registry",
      ledgerInstanceId: evidence.ledgerInstanceId,
      schemaVersion: evidence.schemaVersion,
    },
    ...(["azure", "blacksmith"] as const).map((provider) => controlEntity(provider, evidence)),
    {
      partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
      rowKey: FOUNDATION_ROW_KEYS[3],
      document: JSON.stringify({
        lastSucceededAt: null,
        ledgerInstanceId: evidence.ledgerInstanceId,
        schemaVersion: evidence.schemaVersion,
      }),
      entityType: "reconciler-heartbeat",
      lastSucceededAt: "",
      ledgerInstanceId: evidence.ledgerInstanceId,
      schemaVersion: evidence.schemaVersion,
    },
  ];
}

function controlEntity(
  provider: ProviderName,
  evidence: AzureLedgerInstanceEvidence,
): TableEntity<Record<string, unknown>> {
  const document = {
    accountedDailyCostUsdCents: 0,
    activeReservations: 0,
    initialisedAt: evidence.initialisedAt,
    ledgerInstanceId: evidence.ledgerInstanceId,
    provider,
    schemaVersion: evidence.schemaVersion,
    utcDay: evidence.utcDay,
  };
  return {
    partitionKey: AZURE_TABLE_LEDGER_PARTITION_KEY,
    rowKey: `control!${provider}`,
    accountedDailyCostUsdCents: 0,
    activeReservations: 0,
    document: JSON.stringify(document),
    entityType: "provider-control",
    ledgerInstanceId: evidence.ledgerInstanceId,
    provider,
    schemaVersion: evidence.schemaVersion,
    utcDay: evidence.utcDay,
  };
}

function matchesExactFoundation(
  rows: ReadonlyArray<TableEntityResult<Record<string, unknown>>>,
  evidence: AzureLedgerInstanceEvidence,
): boolean {
  if (rows.length !== FOUNDATION_ROW_KEYS.length) {
    return false;
  }
  const expected = new Map(
    foundationEntities(evidence).map((entity) => [String(entity.rowKey), entity]),
  );
  return rows.every((row) => {
    const candidate = row as Record<string, unknown>;
    const expectedEntity = expected.get(String(candidate.rowKey));
    if (expectedEntity === undefined) {
      return false;
    }
    const allowedKeys = new Set([...SYSTEM_ENTITY_KEYS, ...Object.keys(expectedEntity)]);
    if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
      return false;
    }
    return Object.entries(expectedEntity).every(([key, value]) => candidate[key] === value);
  });
}

function validateEvidence(value: AzureLedgerInstanceEvidence): AzureLedgerInstanceEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as unknown as Record<string, unknown>, [
      "initialisedAt",
      "ledgerInstanceId",
      "schemaVersion",
      "utcDay",
    ])
  ) {
    throw invalid("ledger bootstrap evidence has missing or unsupported fields");
  }
  if (
    typeof value.ledgerInstanceId !== "string" ||
    value.ledgerInstanceId.trim().length === 0 ||
    value.ledgerInstanceId.length > 256
  ) {
    throw invalid("ledgerInstanceId must be a non-empty string of at most 256 characters");
  }
  if (value.schemaVersion !== AZURE_TABLE_LEDGER_SCHEMA_VERSION) {
    throw invalid(`schemaVersion must be ${AZURE_TABLE_LEDGER_SCHEMA_VERSION}`);
  }
  const parsed = new Date(value.initialisedAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value.initialisedAt) {
    throw invalid("initialisedAt must be a canonical UTC timestamp");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value.utcDay) ||
    value.utcDay !== value.initialisedAt.slice(0, 10)
  ) {
    throw invalid("utcDay must match the UTC day of initialisedAt");
  }
  return { ...value };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function requireStorageAccountName(value: string): string {
  if (!/^[a-z0-9]{3,24}$/.test(value)) {
    throw invalid("accountName must be a 3-24 character lowercase Azure Storage account name");
  }
  return value;
}

function requireTableName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(value)) {
    throw invalid("tableName must be a valid 3-63 character Azure Table name");
  }
  return value;
}

function invalid(message: string): AllocationLedgerError {
  return new AllocationLedgerError("invalid-ledger-request", message);
}
