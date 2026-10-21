import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  assertRuntimeAppBoundary,
  runtimeAppBoundaryViolations,
} from "./check-runtime-app-boundary.mjs";

const fixtures = resolve("scripts/fixtures/runtime-app-boundary");

const dependencyViolations = runtimeAppBoundaryViolations({
  appsRoot: resolve(fixtures, "dependency-sections"),
});
for (const section of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  assert.equal(
    dependencyViolations.some((violation) => violation.includes(` in ${section} in `)),
    true,
    `fixture must reject ${section}`,
  );
}

for (const [fixture, label] of [
  ["static-import", "source import/reference"],
  ["require", "source import/reference"],
  ["dynamic-import", "source import/reference"],
]) {
  const violations = runtimeAppBoundaryViolations({ appsRoot: resolve(fixtures, fixture) });
  assert.equal(
    violations.some((violation) => violation.startsWith(label)),
    true,
    `${fixture} fixture must be rejected even without a declared dependency`,
  );
}

const bundledViolations = runtimeAppBoundaryViolations({
  appsRoot: resolve(fixtures, "passing-app"),
  artifactRoots: [resolve(fixtures, "bundled-artifact")],
});
assert.equal(
  bundledViolations.some((violation) => violation.startsWith("built/bundled")),
  true,
  "bundled bootstrap occurrence fixture must be rejected",
);

assert.doesNotThrow(() => assertRuntimeAppBoundary({ appsRoot: resolve(fixtures, "passing-app") }));
assert.doesNotThrow(() => assertRuntimeAppBoundary());

console.log("Verified runtime-app boundary rejection fixtures and the current apps tree.");
