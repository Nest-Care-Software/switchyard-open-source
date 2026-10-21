import { requireExactKeys, requireRecord } from "@switchyard/core";

import { requireCommittedActivationConfiguration } from "./activation.js";
import {
  commitSha,
  decimalId,
  type GitHubOidcEntraExchangePort,
  type GitHubOidcTokenRequestPort,
  type GitHubOidcTokenVerifierPort,
  INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
  InfrastructureApprovalError,
  type InfrastructureApprovalPolicy,
  type InfrastructureIdentitySession,
  requireActivationOidcSettings,
  type StateIdentity,
  stateEtag,
  validatePolicy,
  validateStateIdentity,
  verifyJobEvidence,
  verifyReferencedWorkflow,
  verifyRunEvidence,
} from "./contracts.js";
import type { InfrastructureGitHubEvidencePort } from "./github-evidence.js";
import { withVerifiedInfrastructureIdentity } from "./identity.js";

export interface InitialStateBootstrapPort {
  initialise(session: InfrastructureIdentitySession): Promise<{
    readonly identity: StateIdentity;
    readonly recordEtag: string;
  }>;
}

export interface InitialStateEngineRequest {
  readonly commitSha: string;
  readonly jobCheckRunId: string;
  readonly jobWorkflowSha: string;
  readonly runId: string;
}

export interface InitialStateEngineResult {
  readonly backendStateDigest: string;
  readonly backendStateEtag: string;
  readonly lineage: string;
  readonly recordEtag: string;
  readonly serial: 0;
  readonly status: "initialised";
}

export class InfrastructureInitialStateEngine {
  constructor(
    private readonly policy: InfrastructureApprovalPolicy,
    private readonly github: InfrastructureGitHubEvidencePort,
    private readonly tokenRequester: GitHubOidcTokenRequestPort,
    private readonly verifier: GitHubOidcTokenVerifierPort,
    private readonly entra: GitHubOidcEntraExchangePort,
    private readonly bootstrap: InitialStateBootstrapPort,
  ) {
    validatePolicy(policy);
  }

  async initialise(request: InitialStateEngineRequest): Promise<InitialStateEngineResult> {
    requireExactKeys(
      requireRecord(request, "initialStateRequest"),
      ["commitSha", "jobCheckRunId", "jobWorkflowSha", "runId"],
      "initialStateRequest",
    );
    const targetCommit = commitSha(request.commitSha, "request.commitSha");
    const runId = decimalId(request.runId, "request.runId");
    const jobCheckRunId = decimalId(request.jobCheckRunId, "request.jobCheckRunId");
    const jobWorkflowSha = commitSha(request.jobWorkflowSha, "request.jobWorkflowSha");
    const [run, currentMainSha, settings, job, activationBytes] = await Promise.all([
      this.github.getRun(runId),
      this.github.getCurrentMainSha(),
      this.github.getOidcSettings(),
      this.github.getJob({ checkRunId: jobCheckRunId, runId }),
      this.github.getActivationConfiguration(targetCommit),
    ]);
    requireCommittedActivationConfiguration(this.policy, activationBytes);
    requireActivationOidcSettings(settings);
    verifyRunEvidence(run, {
      commitSha: targetCommit,
      runId,
      workflowPath: INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
    });
    verifyReferencedWorkflow(run, this.policy.applyEngineSha, "apply");
    verifyJobEvidence(job, { checkRunId: jobCheckRunId, commitSha: targetCommit, runId });
    if (run.status !== "in_progress" || run.conclusion !== null || run.completedAt !== null) {
      throw new InfrastructureApprovalError("initial-state-run-not-active-first-attempt");
    }
    if (currentMainSha !== targetCommit) {
      throw new InfrastructureApprovalError("main-moved-before-initial-state");
    }
    if (jobWorkflowSha !== this.policy.applyEngineSha) {
      throw new InfrastructureApprovalError("initial-state-job-workflow-sha-mismatch");
    }
    return withVerifiedInfrastructureIdentity({
      callerWorkflowPath: INFRASTRUCTURE_INITIAL_STATE_DISPATCHER_PATH,
      entra: this.entra,
      identity: "bootstrap-applier",
      job,
      jobWorkflowSha,
      policy: this.policy,
      requester: this.tokenRequester,
      run,
      verifier: this.verifier,
      work: async (session) => {
        const result = await this.bootstrap.initialise(session);
        validateStateIdentity(result.identity, "initialState.identity");
        stateEtag(result.recordEtag, "initialState.recordEtag");
        if (
          result.identity.serial !== 0 ||
          !result.identity.managedResourcesEmpty ||
          result.identity.managedResourceCount !== 0
        ) {
          throw new InfrastructureApprovalError("initial-state-result-invalid");
        }
        return Object.freeze({
          backendStateDigest: result.identity.backendStateDigest,
          backendStateEtag: result.identity.backendStateEtag,
          lineage: result.identity.lineage,
          recordEtag: result.recordEtag,
          serial: 0 as const,
          status: "initialised" as const,
        });
      },
    });
  }
}
