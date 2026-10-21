import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { azureGenerationOneNames } from "../src/index.js";

const ALLOCATION_ID = `sy1-${"a1".repeat(32)}`;

describe("Azure generation-one names", () => {
  it("creates stable distinct zone and operation identities", () => {
    const first = azureGenerationOneNames({
      allocationId: ALLOCATION_ID,
      subscriptionId: "11111111-2222-3333-4444-555555555555",
    });
    const retry = azureGenerationOneNames({
      allocationId: ALLOCATION_ID,
      subscriptionId: "11111111-2222-3333-4444-555555555555",
    });
    assert.deepEqual(retry, first);
    assert.equal(new Set(Object.values(first.baseDeploymentNameByZone)).size, 3);
    assert.match(first.resourceGroupName, /^rg-switchyard-allocation-[a-f0-9]{24}$/);
    assert.equal(
      first.resourceGroupId,
      `/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/${first.resourceGroupName}`,
    );
    assert.notEqual(first.jitDeploymentName, first.baseDeploymentNameByZone["1"]);
    assert.equal(
      first.jitDeploymentId,
      `${first.resourceGroupId}/providers/Microsoft.Resources/deployments/${first.jitDeploymentName}`,
    );
    assert.equal(first.childDeploymentName, `switchyard-allocation-${"a1".repeat(10)}-g1`);
    assert.equal(first.vmName, `swy-${"a1".repeat(10)}-g1`);
    assert.equal(
      first.vmResourceId,
      `${first.resourceGroupId}/providers/Microsoft.Compute/virtualMachines/${first.vmName}`,
    );
  });

  it("rejects mutable or malformed identity inputs", () => {
    assert.throws(
      () => azureGenerationOneNames({ allocationId: "allocation", subscriptionId: "sub" }),
      /canonical Switchyard ID/,
    );
    assert.throws(
      () => azureGenerationOneNames({ allocationId: ALLOCATION_ID, subscriptionId: "sub/other" }),
      /Azure subscription identifier/,
    );
  });
});
