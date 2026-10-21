import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const path = "infra/foundation/configure-operator.sh";
const source = readFileSync(path, "utf8");

describe("one-time operator Azure operator bootstrap", () => {
  it("pins the exact operator, subscription and narrowly delegated authority", () => {
    assert.match(source, /a0000000-0000-4000-8000-000000000001/);
    assert.match(source, /a0000000-0000-4000-8000-000000000002/);
    assert.match(source, /a0000000-0000-4000-8000-00000000000a/);
    assert.match(source, /a0000000-0000-4000-8000-00000000000b/);
    assert.match(source, /a0000000-0000-4000-8000-000000000009/);
    assert.match(source, /3ad77f1d-46f0-5203-b2d8-2ccfa0bcf5e3/);
    assert.match(source, /f58310d9-a9f6-439a-9e8d-f62e7b41a168/);
    assert.match(source, /RoleDefinitionId.*GuidEquals/);
    assert.match(source, /PrincipalId.*GuidEquals/);
    assert.match(source, /PrincipalType.*ServicePrincipal/);
  });

  it("verifies authority before replacing and printing the sole credential", () => {
    const authorityVerification = source.indexOf("restricted_count=");
    const credentialReset = source.indexOf("az ad app credential reset");
    const credentialOutput = source.indexOf("AZURE_CLIENT_SECRET");
    assert.ok(authorityVerification >= 0);
    assert.ok(credentialReset > authorityVerification);
    assert.ok(credentialOutput > credentialReset);
    assert.match(source, /credential reset[\s\S]*--display-name 'switchyard-example-operator'/);
    assert.doesNotMatch(source, /--append/);
  });

  it("does not log in, create resources or grant broad contributor and owner roles", () => {
    assert.doesNotMatch(source, /\baz\s+login\b/);
    assert.doesNotMatch(source, /--all/);
    assert.doesNotMatch(source, /\b(?:tofu|terraform)\s+(?:plan|apply|destroy)\b/);
    assert.doesNotMatch(source, /\b(?:Owner|Contributor)\b/);
    assert.doesNotMatch(source, /resource\s+(?:create|delete)|deployment\s+(?:create|delete)/);
  });
});
