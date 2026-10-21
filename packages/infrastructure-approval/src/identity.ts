import {
  copyRawOidcToken,
  type DeploymentIdentityClass,
  futureIdentityContracts,
  type GitHubOidcEntraExchangePort,
  type GitHubOidcTokenRequestPort,
  type GitHubOidcTokenVerifierPort,
  type GitHubRunEvidence,
  InfrastructureApprovalError,
  type InfrastructureApprovalPolicy,
  type InfrastructureIdentitySession,
  identityClientId,
  identityPrincipalId,
  SWITCHYARD_REPOSITORY,
  sha256Bytes,
  verifyIdentitySession,
  verifyOidcClaims,
} from "./contracts.js";

export async function withVerifiedInfrastructureIdentity<T>(input: {
  readonly callerWorkflowPath: string;
  readonly entra: GitHubOidcEntraExchangePort;
  readonly identity: DeploymentIdentityClass;
  readonly job: import("./contracts.js").GitHubJobEvidence;
  readonly jobWorkflowSha: string;
  readonly policy: InfrastructureApprovalPolicy;
  readonly requester: GitHubOidcTokenRequestPort;
  readonly run: GitHubRunEvidence;
  readonly verifier: GitHubOidcTokenVerifierPort;
  readonly work: (
    session: InfrastructureIdentitySession,
    transientRawToken: Uint8Array,
  ) => Promise<T>;
}): Promise<T> {
  const engineSha =
    input.identity === "planner" ? input.policy.planEngineSha : input.policy.applyEngineSha;
  if (input.jobWorkflowSha !== engineSha) {
    throw new InfrastructureApprovalError("job-workflow-sha-mismatch-before-token-request");
  }
  const contract = futureIdentityContracts(input.policy)[input.identity];
  let requested: Uint8Array | undefined;
  let rawToken: Uint8Array | undefined;
  try {
    requested = await classifyUnexpected("identity-oidc-request-unexpected", () =>
      input.requester.requestToken({ audience: contract.audience }),
    );
    rawToken = copyRawOidcToken(requested, "githubOidcToken");
    requested.fill(0);
    requested = undefined;
    const tokenDigest = sha256Bytes(rawToken);
    const claims = await classifyUnexpected("identity-oidc-verification-unexpected", () =>
      input.verifier.verifyCryptographically(rawToken as Uint8Array),
    );
    requireTokenUnchanged(rawToken, tokenDigest);
    await classifyUnexpected("identity-oidc-claims-unexpected", async () => {
      verifyOidcClaims(
        claims,
        input.identity,
        input.callerWorkflowPath,
        input.job,
        input.run,
        input.policy,
        tokenDigest,
      );
    });
    if (claims.jobWorkflowSha !== input.jobWorkflowSha) {
      throw new InfrastructureApprovalError("oidc-job-context-workflow-sha-mismatch");
    }
    const enginePath =
      input.identity === "planner"
        ? ".github/workflows/infrastructure-plan-engine.yml"
        : ".github/workflows/infrastructure-apply-engine.yml";
    const jobWorkflowRef = `${SWITCHYARD_REPOSITORY}/${enginePath}@${engineSha}`;
    const session = await classifyUnexpected("identity-entra-exchange-unexpected", () =>
      input.entra.exchangeExactToken({
        allowAmbientCredentials: false,
        audience: contract.audience,
        clientId: identityClientId(input.policy, input.identity),
        identity: input.identity,
        jobWorkflowRef,
        principalId: identityPrincipalId(input.policy, input.identity),
        rawToken: rawToken as Uint8Array,
        subject: contract.subject,
        subscriptionId: input.policy.subscriptionId,
        tenantId: input.policy.tenantId,
      }),
    );
    requireTokenUnchanged(rawToken, tokenDigest);
    verifyIdentitySession(session, input.identity, input.policy, tokenDigest);
    return await input.work(session, rawToken);
  } finally {
    requested?.fill(0);
    rawToken?.fill(0);
  }
}

async function classifyUnexpected<T>(code: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InfrastructureApprovalError) throw error;
    throw new InfrastructureApprovalError(code);
  }
}

function requireTokenUnchanged(token: Uint8Array, digest: string): void {
  if (sha256Bytes(token) !== digest) throw new InfrastructureApprovalError("oidc-token-mutated");
}
