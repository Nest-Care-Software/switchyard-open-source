import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const corePackage = JSON.parse(readFileSync("packages/core/package.json", "utf8"));
for (const dependencyGroup of ["dependencies", "devDependencies", "optionalDependencies"]) {
  assert.equal(
    corePackage[dependencyGroup]?.["@switchyard/reporting"],
    undefined,
    `@switchyard/core must not depend on reporting through ${dependencyGroup}`,
  );
}

const allocationDecisionFiles = [
  "packages/core/src/allocation-policy.ts",
  "packages/core/src/controller-health.ts",
  "packages/core/src/provider-limits.ts",
  "packages/core/src/provider.ts",
  "packages/core/src/workflow-contract.ts",
];
for (const file of allocationDecisionFiles) {
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /@switchyard\/reporting|D1ReportingStore|REPORTING_DB/);
}

console.log("Verified that reporting cannot enter allocation, fallback or controller health code.");
