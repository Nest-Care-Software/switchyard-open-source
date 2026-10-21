import assert from "node:assert/strict";

await import("@switchyard/core");
await import("@switchyard/core/testing");
await import("@switchyard/controller");
await import("@switchyard/github");
await import("@switchyard/github/testing");
await import("@switchyard/reporting");
const runtime = await import("@switchyard/azure-ledger");
const provisioning = await import("@switchyard/azure-ledger-bootstrap");
const azureWorker = await import("@switchyard/azure-worker");
const reconciler = await import("@switchyard/reconciler");
const recovery = await import("@switchyard/recovery");
const infrastructureApproval = await import("@switchyard/infrastructure-approval");

assert.equal("AzureTableLedgerBootstrap" in runtime, false);
assert.equal("createAzureTableLedgerBootstrap" in runtime, false);
assert.equal(typeof provisioning.createAzureTableLedgerBootstrap, "function");
assert.equal(typeof azureWorker.AzureGenerationOneWorker, "function");
assert.equal(typeof reconciler.AllocationReconciler, "function");
assert.equal(typeof recovery.recoverAzureAllocation, "function");
assert.equal(typeof infrastructureApproval.InfrastructurePlanEngine, "function");
assert.equal(typeof infrastructureApproval.InfrastructureApplyEngine, "function");
assert.equal(typeof infrastructureApproval.InfrastructureInitialStateEngine, "function");
assert.equal(typeof infrastructureApproval.LiveGitHubOidcEntraExchange, "function");
assert.equal(typeof infrastructureApproval.LiveOpenTofuRuntime, "function");

await assert.rejects(
  import("@switchyard/azure-ledger/bootstrap"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "the runtime package must not expose a provisioning subpath",
);
