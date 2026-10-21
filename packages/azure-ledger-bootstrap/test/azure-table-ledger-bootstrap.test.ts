import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  TableEntity,
  TableEntityResult,
  TableTransactionResponse,
  TransactionAction,
} from "@azure/data-tables";
import {
  AZURE_TABLE_LEDGER_PARTITION_KEY,
  AZURE_TABLE_LEDGER_SCHEMA_VERSION,
} from "@switchyard/azure-ledger";
import {
  AzureTableLedgerBootstrap,
  type AzureTableLedgerProvisioningCapability,
  type AzureTableLedgerProvisioningPort,
  createAzureTableLedgerBootstrap,
} from "../src/index.js";

const EVIDENCE = {
  initialisedAt: "2026-08-25T00:00:00.000Z",
  ledgerInstanceId: "switchyard-ledger-bootstrap-test",
  schemaVersion: AZURE_TABLE_LEDGER_SCHEMA_VERSION,
  utcDay: "2026-08-25",
} as const;

describe("one-time Azure Table ledger bootstrap", () => {
  it("constructs only with an explicitly supplied provisioning credential", () => {
    assert.ok(
      createAzureTableLedgerBootstrap({
        accountName: "switchyardledger",
        provisioningCredential: { getToken: async () => null },
        tableName: "SwitchyardLedger",
      }) instanceof AzureTableLedgerBootstrap,
    );
    assert.throws(
      () =>
        createAzureTableLedgerBootstrap({
          accountName: "switchyardledger",
          provisioningCredential: undefined as never,
          tableName: "SwitchyardLedger",
        }),
      hasLedgerCode("invalid-ledger-request"),
    );
  });

  it("creates the registry, both controls and heartbeat atomically in the sole partition", async () => {
    const table = new ProvisioningMemoryTable();
    const result = await bootstrapFor(table).bootstrap(EVIDENCE);

    assert.equal(result.outcome, "created");
    assert.deepEqual(table.rowKeys(), [
      "bootstrap!ledger",
      "control!azure",
      "control!blacksmith",
      "heartbeat!reconciler",
    ]);
    assert.equal(table.transactions.length, 1);
    assert.deepEqual(
      table.transactions[0]?.map((action) => action[0]),
      ["create", "create", "create", "create"],
    );
    assert.equal(
      table.transactions[0]?.every(
        (action) => action[1].partitionKey === AZURE_TABLE_LEDGER_PARTITION_KEY,
      ),
      true,
    );
  });

  it("rejects every surviving foundation, allocation, generation, history or unknown row", async () => {
    for (const [rowKey, entityType, partitionKey] of [
      ["bootstrap!ledger", "bootstrap-registry", AZURE_TABLE_LEDGER_PARTITION_KEY],
      ["control!azure", "provider-control", AZURE_TABLE_LEDGER_PARTITION_KEY],
      ["heartbeat!reconciler", "reconciler-heartbeat", AZURE_TABLE_LEDGER_PARTITION_KEY],
      ["attempt!survivor!01", "provider-attempt", AZURE_TABLE_LEDGER_PARTITION_KEY],
      ["allocation!survivor", "allocation", AZURE_TABLE_LEDGER_PARTITION_KEY],
      ["generation!survivor!01", "physical-generation", AZURE_TABLE_LEDGER_PARTITION_KEY],
      ["allowance-history!azure!2026-08-24", "allowance-history", AZURE_TABLE_LEDGER_PARTITION_KEY],
      ["unknown!survivor", "unknown", "unexpected-partition"],
    ] as const) {
      const table = new ProvisioningMemoryTable();
      await table.seed({ partitionKey, rowKey, document: "{}", entityType });
      await assert.rejects(
        () => bootstrapFor(table).bootstrap(EVIDENCE),
        hasLedgerCode("precondition-failed"),
      );
      assert.deepEqual(table.rowKeys(), [rowKey]);
    }
  });

  it("never treats a later call against an initialised table as recovery", async () => {
    const table = new ProvisioningMemoryTable();
    const bootstrap = bootstrapFor(table);
    await bootstrap.bootstrap(EVIDENCE);
    await assert.rejects(() => bootstrap.bootstrap(EVIDENCE), hasLedgerCode("precondition-failed"));
  });

  it("is idempotent only for identical racing initialisation or a lost response", async () => {
    {
      const table = new ProvisioningMemoryTable();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => bootstrapFor(table).bootstrap(structuredClone(EVIDENCE))),
      );
      assert.equal(results.filter((result) => result.outcome === "created").length, 1);
      assert.equal(results.filter((result) => result.outcome === "exact-race-recovery").length, 11);
    }

    {
      const table = new ProvisioningMemoryTable();
      table.failAfterNextCommit();
      assert.equal((await bootstrapFor(table).bootstrap(EVIDENCE)).outcome, "exact-race-recovery");
    }
  });

  it("fails closed for conflicting racing evidence", async () => {
    const table = new ProvisioningMemoryTable();
    const results = await Promise.allSettled([
      bootstrapFor(table).bootstrap(EVIDENCE),
      bootstrapFor(table).bootstrap({
        ...EVIDENCE,
        ledgerInstanceId: "conflicting-ledger-instance",
      }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.equal(hasLedgerCode("allocation-conflict")(rejected.reason), true);
  });

  it("detects a foreign row inserted after the empty-table proof", async () => {
    const table = new ProvisioningMemoryTable();
    table.injectAfterNextCommit({
      partitionKey: "unexpected-partition",
      rowKey: "foreign-race",
      entityType: "unknown",
    });
    await assert.rejects(
      () => bootstrapFor(table).bootstrap(EVIDENCE),
      hasLedgerCode("allocation-conflict"),
    );
  });
});

class ProvisioningMemoryTable implements AzureTableLedgerProvisioningPort {
  readonly transactions: TransactionAction[][] = [];
  readonly #entities = new Map<string, Record<string, unknown>>();
  #failAfterCommit = false;
  #foreignAfterCommit: TableEntity<Record<string, unknown>> | undefined;
  #revision = 0;

  async *listEntities<T extends object = Record<string, unknown>>(): AsyncIterable<
    TableEntityResult<T>
  > {
    for (const entity of this.#entities.values()) {
      await Promise.resolve();
      yield structuredClone(entity) as TableEntityResult<T>;
    }
  }

  async submitTransaction(actions: TransactionAction[]): Promise<TableTransactionResponse> {
    const cloned = structuredClone(actions);
    assert.equal(new Set(cloned.map((action) => action[1].partitionKey)).size, 1);
    const staged = structuredClone(this.#entities);
    const responses: Array<{ etag: string; rowKey: string; status: number }> = [];
    for (const action of cloned) {
      const [operation, entity] = action;
      assert.equal(operation, "create");
      const entityKey = key(entity.partitionKey, entity.rowKey);
      if (staged.has(entityKey)) {
        throw { statusCode: 409 };
      }
      const etag = `table-${++this.#revision}`;
      staged.set(entityKey, { ...structuredClone(entity), etag });
      responses.push({ etag, rowKey: entity.rowKey, status: 201 });
    }
    this.#entities.clear();
    for (const [entityKey, entity] of staged) {
      this.#entities.set(entityKey, entity);
    }
    this.transactions.push(cloned);
    if (this.#foreignAfterCommit !== undefined) {
      const foreign = this.#foreignAfterCommit;
      this.#foreignAfterCommit = undefined;
      this.#entities.set(key(foreign.partitionKey, foreign.rowKey), {
        ...structuredClone(foreign),
        etag: `table-${++this.#revision}`,
      });
    }
    if (this.#failAfterCommit) {
      this.#failAfterCommit = false;
      throw { statusCode: 503 };
    }
    return {
      status: 202,
      subResponses: responses,
      getResponseForEntity: (rowKey) => responses.find((response) => response.rowKey === rowKey),
    };
  }

  async seed(entity: TableEntity<Record<string, unknown>>): Promise<void> {
    await this.submitTransaction([["create", entity]]);
  }

  failAfterNextCommit(): void {
    this.#failAfterCommit = true;
  }

  injectAfterNextCommit(entity: TableEntity<Record<string, unknown>>): void {
    this.#foreignAfterCommit = entity;
  }

  rowKeys(): string[] {
    return [...this.#entities.values()]
      .map((entity) => String(entity.rowKey))
      .sort((left, right) => left.localeCompare(right));
  }
}

function bootstrapFor(table: ProvisioningMemoryTable): AzureTableLedgerBootstrap {
  const capability: AzureTableLedgerProvisioningCapability = {
    kind: "switchyard-ledger-provisioning",
    tableClient: table,
  };
  return new AzureTableLedgerBootstrap(capability);
}

function key(partitionKey: string, rowKey: string): string {
  return `${partitionKey}\u0000${rowKey}`;
}

function hasLedgerCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}
