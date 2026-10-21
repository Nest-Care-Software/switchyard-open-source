import { timingSafeEqual } from "node:crypto";

import { requireExactKeys, requireRecord } from "@switchyard/core";
import { requireCommittedActivationConfiguration } from "./activation.js";
import { PLAN_BUNDLE_FILENAME } from "./artifact-live.js";
import { classifyOpenTofuPlan } from "./authority.js";
import {
  bundleEntries,
  canonicalPlanManifest,
  createPlanManifest,
  manifestFiles,
  type PlanManifest,
  type PlannerIdentityEvidence,
  verifyPlanArchive,
} from "./bundle.js";
import {
  commitSha,
  decimalId,
  FUTURE_PLAN_DISPATCHER_PATH,
  futureIdentityContracts,
  type GitHubOidcEntraExchangePort,
  type GitHubOidcTokenRequestPort,
  type GitHubOidcTokenVerifierPort,
  InfrastructureApprovalError,
  type InfrastructureApprovalPolicy,
  type InfrastructureIdentitySession,
  PLAN_ARTIFACT_RETENTION_DAYS,
  type PlanAuthorityClass,
  requireActivationOidcSettings,
  SWITCHYARD_REPOSITORY,
  sha256Bytes,
  validatePolicy,
  verifyJobEvidence,
  verifyReferencedWorkflow,
  verifyRunEvidence,
} from "./contracts.js";
import type { InfrastructureGitHubEvidencePort } from "./github-evidence.js";
import { withVerifiedInfrastructureIdentity } from "./identity.js";
import {
  assertExactOpenTofuCommand,
  EXACT_SAVED_PLAN_CREATE_COMMAND,
  EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
  EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
  type FixedOpenTofuPlanPort,
  PINNED_OPEN_TOFU_VERSION,
  type PlannerStateReadPort,
  requireRenderedFromSavedPlan,
} from "./opentofu.js";

export interface PlanEngineRequest {
  readonly authorityClass: PlanAuthorityClass;
  readonly commitSha: string;
  readonly jobCheckRunId: string;
  readonly jobWorkflowSha: string;
  readonly runId: string;
}

export interface PlanArchiveBuilderPort {
  build(
    entries: readonly { readonly contents: Uint8Array; readonly path: string }[],
  ): Promise<Uint8Array>;
}

export interface PlanBundlePublicationPort {
  publishLocalArtifact(input: {
    readonly archiveBytes: Uint8Array;
    readonly artifact: {
      readonly fileName: typeof PLAN_BUNDLE_FILENAME;
      readonly immutable: true;
      readonly name: string;
      readonly retentionDays: typeof PLAN_ARTIFACT_RETENTION_DAYS;
    };
  }): Promise<{
    readonly artifactName: string;
    readonly artifactPath: string;
    readonly byteLength: number;
    readonly fileName: typeof PLAN_BUNDLE_FILENAME;
    readonly retentionDays: typeof PLAN_ARTIFACT_RETENTION_DAYS;
    readonly sha256: string;
  }>;
}

export interface PlanEngineResult {
  readonly artifactDigest: string;
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly manifest: PlanManifest;
  readonly manifestDigest: string;
  readonly planDigest: string;
}

/** Plan-only runtime. Workflow reachability remains independently disabled. */
export class InfrastructurePlanEngine {
  constructor(
    private readonly policy: InfrastructureApprovalPolicy,
    private readonly github: InfrastructureGitHubEvidencePort,
    private readonly tokenRequester: GitHubOidcTokenRequestPort,
    private readonly tokens: GitHubOidcTokenVerifierPort,
    private readonly entra: GitHubOidcEntraExchangePort,
    private readonly planner: FixedOpenTofuPlanPort,
    private readonly state: PlannerStateReadPort,
    private readonly archives: PlanArchiveBuilderPort,
    private readonly publisher: PlanBundlePublicationPort,
    private readonly now: () => Date = () => new Date(),
  ) {
    validatePolicy(policy);
  }

  async createBundle(request: PlanEngineRequest): Promise<PlanEngineResult> {
    requireExactKeys(
      requireRecord(request, "planRequest"),
      ["authorityClass", "commitSha", "jobCheckRunId", "jobWorkflowSha", "runId"],
      "planRequest",
    );
    if (request.authorityClass !== "foundation" && request.authorityClass !== "bootstrap") {
      throw new InfrastructureApprovalError("plan-authority-class-invalid");
    }
    const targetCommit = commitSha(request.commitSha, "request.commitSha");
    const runId = decimalId(request.runId, "request.runId");
    const jobCheckRunId = decimalId(request.jobCheckRunId, "request.jobCheckRunId");
    const jobWorkflowSha = commitSha(request.jobWorkflowSha, "request.jobWorkflowSha");
    const [run, currentMainSha, oidcSettings, job, activationBytes] = await Promise.all([
      this.github.getRun(runId),
      this.github.getCurrentMainSha(),
      this.github.getOidcSettings(),
      this.github.getJob({ checkRunId: jobCheckRunId, runId }),
      this.github.getActivationConfiguration(targetCommit),
    ]);
    requireCommittedActivationConfiguration(this.policy, activationBytes);
    requireActivationOidcSettings(oidcSettings);
    verifyRunEvidence(run, {
      commitSha: targetCommit,
      runId,
      workflowPath: FUTURE_PLAN_DISPATCHER_PATH,
    });
    verifyReferencedWorkflow(run, this.policy.planEngineSha, "plan");
    if (run.status !== "in_progress" || run.conclusion !== null || run.completedAt !== null) {
      throw new InfrastructureApprovalError("plan-run-not-active-first-attempt");
    }
    if (commitSha(currentMainSha, "github.currentMainSha") !== targetCommit) {
      throw new InfrastructureApprovalError("main-moved-before-plan");
    }
    verifyJobEvidence(job, { checkRunId: jobCheckRunId, commitSha: targetCommit, runId });
    if (jobWorkflowSha !== this.policy.planEngineSha) {
      throw new InfrastructureApprovalError("plan-job-workflow-sha-mismatch");
    }
    const targetConfigurationDigest = await this.planner.getTargetConfigurationDigest();
    const contract = futureIdentityContracts(this.policy).planner;
    const jobWorkflowRef = `${SWITCHYARD_REPOSITORY}/.github/workflows/infrastructure-plan-engine.yml@${this.policy.planEngineSha}`;
    return withVerifiedInfrastructureIdentity({
      callerWorkflowPath: FUTURE_PLAN_DISPATCHER_PATH,
      entra: this.entra,
      identity: "planner",
      job,
      jobWorkflowSha,
      policy: this.policy,
      requester: this.tokenRequester,
      run,
      verifier: this.tokens,
      work: async (plannerSession, transientRawToken) => {
        const typedPlannerSession = plannerSession as InfrastructureIdentitySession & {
          readonly identity: "planner";
        };
        const stateBefore = await this.state.readIdentity({
          backend: this.policy.backend,
          plannerSession: typedPlannerSession,
        });
        assertExactOpenTofuCommand("create", EXACT_SAVED_PLAN_CREATE_COMMAND);
        const creation = await this.planner.createSavedPlan({
          authorityClass: request.authorityClass,
          backend: this.policy.backend,
          command: EXACT_SAVED_PLAN_CREATE_COMMAND,
          commitSha: targetCommit,
          expectedState: stateBefore,
          plannerSession: typedPlannerSession,
          subscriptionId: this.policy.subscriptionId,
          tenantId: this.policy.tenantId,
          tofuVersion: PINNED_OPEN_TOFU_VERSION,
          transientGitHubOidcToken: transientRawToken,
        });
        if (creation.savedPlanDigest !== sha256Bytes(creation.savedPlan)) {
          throw new InfrastructureApprovalError("planner-saved-plan-digest-mismatch");
        }
        const stateAfter = await this.state.readIdentity({
          backend: this.policy.backend,
          plannerSession: typedPlannerSession,
        });
        if (!sameState(stateBefore, stateAfter)) {
          throw new InfrastructureApprovalError("state-changed-during-unlocked-plan");
        }
        assertExactOpenTofuCommand("show-json", EXACT_SAVED_PLAN_SHOW_JSON_COMMAND);
        assertExactOpenTofuCommand("show-text", EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND);
        const rendering = await this.planner.renderSavedPlan({
          jsonCommand: EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
          savedPlan: creation.savedPlan,
          textCommand: EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
          tofuVersion: PINNED_OPEN_TOFU_VERSION,
        });
        requireRenderedFromSavedPlan(rendering, creation.savedPlan);
        const classification = classifyOpenTofuPlan(
          new TextDecoder("utf-8", { fatal: true }).decode(rendering.planJson),
          request.authorityClass,
          stateBefore,
        );
        const plannerIdentity: PlannerIdentityEvidence = Object.freeze({
          audience: contract.audience,
          identity: "planner" as const,
          jobWorkflowRef,
          subject: contract.subject,
        });
        const manifest = createPlanManifest({
          activationConfigDigest: this.policy.activationConfigDigest,
          authorityClass: request.authorityClass,
          backend: this.policy.backend,
          changeSummary: classification.summary,
          commitSha: targetCommit,
          createdAt: this.now().toISOString(),
          destructive: classification.destructive,
          files: manifestFiles({
            planJson: rendering.planJson,
            planText: rendering.planText,
            savedPlan: creation.savedPlan,
          }),
          planDispatcherWorkflowRef: run.workflowRef,
          planEngineSha: this.policy.planEngineSha,
          planRunId: runId,
          plannerIdentity,
          priorStateDigest: classification.priorStateDigest,
          state: stateBefore,
          subscriptionId: this.policy.subscriptionId,
          targetConfigurationDigest,
          tenantId: this.policy.tenantId,
        });
        const manifestSource = canonicalPlanManifest(manifest);
        const archiveBytes = await this.archives.build(
          bundleEntries({
            manifestSource,
            planJson: rendering.planJson,
            planText: rendering.planText,
            savedPlan: creation.savedPlan,
          }),
        );
        const verified = await verifyPlanArchive(archiveBytes);
        if (
          canonicalPlanManifest(verified.manifest) !== manifestSource ||
          verified.manifestDigest !== sha256Bytes(new TextEncoder().encode(manifestSource)) ||
          verified.planDigest !== creation.savedPlanDigest ||
          !equalBytes(verified.planJson, rendering.planJson) ||
          !equalBytes(verified.planText, rendering.planText) ||
          !equalBytes(verified.savedPlan, creation.savedPlan)
        ) {
          throw new InfrastructureApprovalError("archive-builder-changed-plan-bundle");
        }
        const publication = await this.publisher.publishLocalArtifact({
          archiveBytes,
          artifact: {
            fileName: PLAN_BUNDLE_FILENAME,
            immutable: true,
            name: `switchyard-infrastructure-plan-${verified.planDigest}`,
            retentionDays: PLAN_ARTIFACT_RETENTION_DAYS,
          },
        });
        if (
          publication.artifactName !== `switchyard-infrastructure-plan-${verified.planDigest}` ||
          publication.fileName !== PLAN_BUNDLE_FILENAME ||
          publication.retentionDays !== PLAN_ARTIFACT_RETENTION_DAYS ||
          publication.byteLength !== archiveBytes.byteLength ||
          publication.sha256 !== verified.archiveDigest
        ) {
          throw new InfrastructureApprovalError("plan-publication-proof-mismatch");
        }
        return Object.freeze({
          artifactDigest: verified.archiveDigest,
          artifactName: publication.artifactName,
          artifactPath: publication.artifactPath,
          manifest,
          manifestDigest: verified.manifestDigest,
          planDigest: verified.planDigest,
        });
      },
    });
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function sameState(
  left: import("./contracts.js").StateIdentity,
  right: import("./contracts.js").StateIdentity,
): boolean {
  return (
    left.backendStateDigest === right.backendStateDigest &&
    left.backendStateEtag === right.backendStateEtag &&
    left.lineage === right.lineage &&
    left.managedResourceCount === right.managedResourceCount &&
    left.managedResourcesEmpty === right.managedResourcesEmpty &&
    left.serial === right.serial
  );
}
