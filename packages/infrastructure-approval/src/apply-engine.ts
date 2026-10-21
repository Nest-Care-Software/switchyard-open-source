import { timingSafeEqual } from "node:crypto";

import { requireExactKeys, requireRecord } from "@switchyard/core";
import { requireCommittedActivationConfiguration } from "./activation.js";
import { classifyOpenTofuPlan, type PlanChangeSummary } from "./authority.js";
import { canonicalPlanManifest, type VerifiedPlanBundle, verifyPlanArchive } from "./bundle.js";
import { type ArtifactTimeEvidence, verifyApprovalChronology } from "./chronology.js";
import {
  type ApprovalInputs,
  type BackendIdentity,
  commitSha,
  type DeploymentIdentityClass,
  decimalId,
  FUTURE_APPLY_DISPATCHER_PATH,
  FUTURE_PLAN_DISPATCHER_PATH,
  futureIdentityContracts,
  type GitHubOidcEntraExchangePort,
  type GitHubOidcTokenRequestPort,
  type GitHubOidcTokenVerifierPort,
  type GitHubRunEvidence,
  InfrastructureApprovalError,
  type InfrastructureApprovalPolicy,
  type InfrastructureIdentitySession,
  instant,
  type PlanAuthorityClass,
  parseApprovalInputs,
  requireActivationOidcSettings,
  requireDestructiveAcknowledgement,
  requireFreshApproval,
  requirePlanFresh,
  type StateIdentity,
  SWITCHYARD_REPOSITORY,
  sha256,
  sha256Bytes,
  sha256Text,
  stateEtag,
  validateBackend,
  validatePolicy,
  validateStateIdentity,
  verifyJobEvidence,
  verifyReferencedWorkflow,
  verifyRunEvidence,
} from "./contracts.js";
import type { InfrastructureGitHubEvidencePort } from "./github-evidence.js";
import { withVerifiedInfrastructureIdentity } from "./identity.js";
import {
  assertExactOpenTofuCommand,
  EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
  EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
  PINNED_OPEN_TOFU_VERSION,
  requireRenderedFromSavedPlan,
  type SavedPlanRenderPort,
} from "./opentofu.js";

export const INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP = "switchyard-infrastructure-apply" as const;
export const EXACT_SAVED_PLAN_APPLY_COMMAND = Object.freeze([
  "tofu",
  "apply",
  "-input=false",
  "-no-color",
  "saved-plan",
] as const);

export interface PlanBundleEvidencePort {
  downloadArtifact(input: { readonly artifactId: string; readonly planRunId: string }): Promise<{
    readonly artifactId: string;
    readonly bytes: Uint8Array;
    readonly createdAt: string;
    readonly expired: boolean;
    readonly expiresAt: string;
    readonly immutable: boolean;
    readonly planRunId: string;
    readonly present: boolean;
    readonly publishedAt: string;
  }>;
}

export interface PrivatePlanReceiptPort {
  ensurePrivateReceipt(input: {
    readonly archiveBytes: Uint8Array;
    readonly contentAddressedKey: string;
    readonly session: InfrastructureIdentitySession;
  }): Promise<{
    readonly bytes: Uint8Array;
    readonly contentAddressedKey: string;
    readonly created: boolean;
    readonly createdAt: string;
    readonly etag: string;
    readonly publishedAt: string;
    readonly sha256: string;
  }>;
}

export interface AuthoritativeStatePort {
  readIdentity(input: {
    readonly backend: BackendIdentity;
    readonly session: InfrastructureIdentitySession;
  }): Promise<StateIdentity>;
  readIdentityUnderLease(input: {
    readonly backend: BackendIdentity;
    readonly lease: ApplyLeaseEvidence;
    readonly session: InfrastructureIdentitySession;
  }): Promise<StateIdentity>;
}

export interface ApplyLeaseEvidence {
  readonly acquired: true;
  readonly key: typeof INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP;
  readonly leaseId: string;
}

export interface AuthoritativeApplyLeasePort {
  withLease<T>(input: {
    readonly key: typeof INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP;
    readonly session: InfrastructureIdentitySession;
    readonly work: (lease: ApplyLeaseEvidence) => Promise<T>;
  }): Promise<T>;
}

export type ApplyTerminalFailure = "failed" | "native-lock-failed" | "partial" | "stale-plan";

export interface ApplyExecutionPort {
  applyExactSavedPlan(input: {
    readonly authorityClass: PlanAuthorityClass;
    readonly command: typeof EXACT_SAVED_PLAN_APPLY_COMMAND;
    readonly savedPlan: Uint8Array;
    readonly session: InfrastructureIdentitySession;
    readonly transientGitHubOidcToken: Uint8Array;
  }): Promise<
    | {
        readonly appliedPlanDigest: string;
        readonly outcome: "completed";
        readonly resultDigest: string;
        readonly stateAfter: StateIdentity;
      }
    | {
        readonly outcome: ApplyTerminalFailure;
        readonly resultDigest: string;
      }
  >;
}

interface IntentBase {
  readonly approvalRunId: string;
  readonly archiveDigest: string;
  readonly artifactId: string;
  readonly authorityClass: PlanAuthorityClass;
  readonly commandDigest: string;
  readonly commitSha: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly planRunId: string;
  readonly savedPlanDigest: string;
  readonly startedAt: string;
  readonly stateBefore: StateIdentity;
}

export type StartedApplyIntentReceipt = IntentBase & {
  readonly receiptDigest: string;
  readonly status: "started";
};

export type ApplyIntentReceipt =
  | StartedApplyIntentReceipt
  | (IntentBase & {
      readonly finishedAt: string;
      readonly receiptDigest: string;
      readonly resultDigest: string;
      readonly status: ApplyTerminalFailure | "unknown";
    })
  | (IntentBase & {
      readonly appliedPlanDigest: string;
      readonly finishedAt: string;
      readonly receiptDigest: string;
      readonly resultDigest: string;
      readonly stateAfter: StateIdentity;
      readonly status: "completed";
    });

type WithoutReceiptDigest<T> = T extends unknown ? Omit<T, "receiptDigest"> : never;
type ApplyIntentBody = WithoutReceiptDigest<ApplyIntentReceipt>;

export interface ApplyIntentReceiptPort {
  createStarted(input: {
    readonly proposed: StartedApplyIntentReceipt;
    readonly session: InfrastructureIdentitySession;
  }): Promise<{
    readonly outcome: "created" | "exists";
    readonly receipt: ApplyIntentReceipt;
  }>;
  replace(input: {
    readonly expectedReceiptDigest: string;
    readonly next: ApplyIntentReceipt;
    readonly planDigest: string;
    readonly session: InfrastructureIdentitySession;
  }): Promise<ApplyIntentReceipt>;
  read(input: {
    readonly planDigest: string;
    readonly session: InfrastructureIdentitySession;
  }): Promise<ApplyIntentReceipt | null>;
}

export interface ApplyEngineRequest {
  readonly approvalInputsJson: string;
  readonly approvalRunId: string;
  readonly jobCheckRunId: string;
  readonly jobWorkflowSha: string;
}

export interface ApplyEngineResult {
  readonly planDigest: string;
  readonly receiptDigest: string;
  readonly replayed: boolean;
  readonly resultDigest: string;
  readonly status: "completed";
}

/** Saved-plan-only apply runtime. Workflow reachability remains independently disabled. */
export class InfrastructureApplyEngine {
  constructor(
    private readonly policy: InfrastructureApprovalPolicy,
    private readonly github: InfrastructureGitHubEvidencePort,
    private readonly bundles: PlanBundleEvidencePort,
    private readonly receipts: PrivatePlanReceiptPort,
    private readonly tokenRequester: GitHubOidcTokenRequestPort,
    private readonly tokens: GitHubOidcTokenVerifierPort,
    private readonly renderer: SavedPlanRenderPort,
    private readonly entra: GitHubOidcEntraExchangePort,
    private readonly state: AuthoritativeStatePort,
    private readonly lease: AuthoritativeApplyLeasePort,
    private readonly intents: ApplyIntentReceiptPort,
    private readonly applier: ApplyExecutionPort,
    private readonly now: () => Date = () => new Date(),
  ) {
    validatePolicy(policy);
  }

  async apply(request: ApplyEngineRequest): Promise<ApplyEngineResult> {
    requireExactKeys(
      requireRecord(request, "applyRequest"),
      ["approvalInputsJson", "approvalRunId", "jobCheckRunId", "jobWorkflowSha"],
      "applyRequest",
    );
    const inputs = parseApprovalInputs(request.approvalInputsJson);
    const approvalRunId = decimalId(request.approvalRunId, "request.approvalRunId");
    const jobCheckRunId = decimalId(request.jobCheckRunId, "request.jobCheckRunId");
    const jobWorkflowSha = commitSha(request.jobWorkflowSha, "request.jobWorkflowSha");
    const initialNow = this.now();
    const [approvalRun, planRun, currentMainSha, oidcSettings, job, activationBytes] =
      await Promise.all([
        this.github.getRun(approvalRunId),
        this.github.getRun(inputs.planRunId),
        this.github.getCurrentMainSha(),
        this.github.getOidcSettings(),
        this.github.getJob({ checkRunId: jobCheckRunId, runId: approvalRunId }),
        this.github.getActivationConfiguration(inputs.commitSha),
      ]);
    requireCommittedActivationConfiguration(this.policy, activationBytes);
    this.verifyRuns(approvalRun, planRun, approvalRunId, inputs);
    requireActivationOidcSettings(oidcSettings);
    requireFreshApproval(approvalRun.createdAt, initialNow);
    if (currentMainSha !== inputs.commitSha) throw new InfrastructureApprovalError("main-moved");
    verifyJobEvidence(job, {
      checkRunId: jobCheckRunId,
      commitSha: inputs.commitSha,
      runId: approvalRunId,
    });
    if (jobWorkflowSha !== this.policy.applyEngineSha) {
      throw new InfrastructureApprovalError("apply-job-workflow-sha-mismatch");
    }

    const artifact = await this.bundles.downloadArtifact({
      artifactId: inputs.artifactId,
      planRunId: inputs.planRunId,
    });
    if (
      artifact.artifactId !== inputs.artifactId ||
      artifact.planRunId !== inputs.planRunId ||
      artifact.immutable !== true
    ) {
      throw new InfrastructureApprovalError("github-artifact-evidence-mismatch");
    }
    const bundle = await verifyPlanArchive(artifact.bytes);
    if (bundle.planDigest !== inputs.planDigest) {
      throw new InfrastructureApprovalError("approved-plan-digest-mismatch");
    }
    this.verifyManifest(bundle, inputs, planRun);
    const artifactTimes = artifact as ArtifactTimeEvidence;
    verifyApprovalChronology({
      approvalRun,
      artifact: artifactTimes,
      manifestCreatedAt: bundle.manifest.createdAt,
      now: initialNow,
      planRun,
    });
    requirePlanFresh(bundle.manifest.createdAt, bundle.manifest.expiresAt, initialNow);
    requireDestructiveAcknowledgement(
      bundle.manifest.destructive,
      inputs.destructiveAcknowledgement,
      inputs.planDigest,
    );

    assertExactOpenTofuCommand("show-json", EXACT_SAVED_PLAN_SHOW_JSON_COMMAND);
    assertExactOpenTofuCommand("show-text", EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND);
    const rerendered = await this.renderer.renderSavedPlan({
      jsonCommand: EXACT_SAVED_PLAN_SHOW_JSON_COMMAND,
      savedPlan: Uint8Array.from(bundle.savedPlan),
      textCommand: EXACT_SAVED_PLAN_SHOW_TEXT_COMMAND,
      tofuVersion: PINNED_OPEN_TOFU_VERSION,
    });
    requireRenderedFromSavedPlan(rerendered, bundle.savedPlan);
    if (
      !equalBytes(rerendered.planJson, bundle.planJson) ||
      !equalBytes(rerendered.planText, bundle.planText)
    ) {
      throw new InfrastructureApprovalError("saved-plan-render-evidence-mismatch");
    }
    const classification = classifyOpenTofuPlan(
      new TextDecoder("utf-8", { fatal: true }).decode(rerendered.planJson),
      bundle.manifest.authorityClass,
      bundle.manifest.state,
    );
    if (
      classification.destructive !== bundle.manifest.destructive ||
      classification.priorStateDigest !== bundle.manifest.renderEvidence.priorStateDigest ||
      !sameSummary(classification.summary, bundle.manifest.changeSummary)
    ) {
      throw new InfrastructureApprovalError("manifest-plan-classification-mismatch");
    }
    const targetConfigurationDigest = await this.renderer.getTargetConfigurationDigest();
    if (targetConfigurationDigest !== bundle.manifest.targetConfigurationDigest) {
      throw new InfrastructureApprovalError("target-configuration-digest-mismatch");
    }

    const identity = identityFor(bundle.manifest.authorityClass);
    return withVerifiedInfrastructureIdentity({
      callerWorkflowPath: FUTURE_APPLY_DISPATCHER_PATH,
      entra: this.entra,
      identity,
      job,
      jobWorkflowSha,
      policy: this.policy,
      requester: this.tokenRequester,
      run: approvalRun,
      verifier: this.tokens,
      work: async (session, transientRawToken) => {
        const receiptKey = `plans/${bundle.planDigest}/${bundle.archiveDigest}.zip`;
        const receipt = await this.receipts.ensurePrivateReceipt({
          archiveBytes: Uint8Array.from(artifact.bytes),
          contentAddressedKey: receiptKey,
          session,
        });
        if (
          receipt.contentAddressedKey !== receiptKey ||
          typeof receipt.created !== "boolean" ||
          receipt.sha256 !== bundle.archiveDigest ||
          sha256Bytes(receipt.bytes) !== receipt.sha256 ||
          !equalBytes(receipt.bytes, artifact.bytes)
        ) {
          throw new InfrastructureApprovalError("private-receipt-mismatch");
        }
        verifyReceiptEvidence(receipt, this.now());

        const stateAfterLogin = await this.state.readIdentity({
          backend: this.policy.backend,
          session,
        });
        const existingIntent = await this.intents.read({ planDigest: bundle.planDigest, session });
        if (existingIntent === null) {
          requireState(stateAfterLogin, bundle.manifest.state, "state-changed-before-lease");
        } else {
          validateIntentReceipt(existingIntent);
          const expected = startedIntentFor({
            approvalRunId,
            bundle,
            inputs,
            startedAt: existingIntent.startedAt,
          });
          requireSameIntent(existingIntent, expected);
          if (existingIntent.status !== "completed") {
            throw new InfrastructureApprovalError(
              `intent-${existingIntent.status}-requires-replan`,
            );
          }
          requireCompletedProof(existingIntent, stateAfterLogin, bundle.planDigest);
          return resultFromCompleted(existingIntent, true);
        }

        await this.recheckBeforeAuthority({
          approvalRunId,
          artifact: artifactTimes,
          inputs,
          manifestCreatedAt: bundle.manifest.createdAt,
          manifestExpiresAt: bundle.manifest.expiresAt,
        });

        return this.lease.withLease({
          key: INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP,
          session,
          work: async (lease) => {
            if (
              lease.acquired !== true ||
              lease.key !== INFRASTRUCTURE_APPLY_CONCURRENCY_GROUP ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                lease.leaseId,
              )
            ) {
              throw new InfrastructureApprovalError("apply-lease-proof-invalid");
            }
            const currentState = await this.state.readIdentityUnderLease({
              backend: this.policy.backend,
              lease,
              session,
            });
            return this.applyUnderLease({
              approvalRunId,
              artifact: artifactTimes,
              bundle,
              currentState,
              inputs,
              lease,
              session,
              transientRawToken,
            });
          },
        });
      },
    });
  }

  private verifyRuns(
    approvalRun: GitHubRunEvidence,
    planRun: GitHubRunEvidence,
    approvalRunId: string,
    inputs: ApprovalInputs,
  ): void {
    verifyRunEvidence(approvalRun, {
      commitSha: inputs.commitSha,
      runId: approvalRunId,
      workflowPath: FUTURE_APPLY_DISPATCHER_PATH,
    });
    verifyRunEvidence(planRun, {
      commitSha: inputs.commitSha,
      runId: inputs.planRunId,
      workflowPath: FUTURE_PLAN_DISPATCHER_PATH,
    });
    verifyReferencedWorkflow(approvalRun, this.policy.applyEngineSha, "apply");
    verifyReferencedWorkflow(planRun, this.policy.planEngineSha, "plan");
  }

  private verifyManifest(
    bundle: VerifiedPlanBundle,
    inputs: ApprovalInputs,
    planRun: GitHubRunEvidence,
  ): void {
    const manifest = bundle.manifest;
    const planner = futureIdentityContracts(this.policy).planner;
    const planJobRef = `${SWITCHYARD_REPOSITORY}/.github/workflows/infrastructure-plan-engine.yml@${this.policy.planEngineSha}`;
    if (
      manifest.commitSha !== inputs.commitSha ||
      manifest.activationConfigDigest !== this.policy.activationConfigDigest ||
      manifest.planRunId !== inputs.planRunId ||
      manifest.planDispatcherWorkflowRef !== planRun.workflowRef ||
      manifest.planEngineSha !== this.policy.planEngineSha ||
      manifest.planJobWorkflowRef !== planJobRef ||
      manifest.plannerIdentity.identity !== "planner" ||
      manifest.plannerIdentity.audience !== planner.audience ||
      manifest.plannerIdentity.subject !== planner.subject ||
      manifest.plannerIdentity.jobWorkflowRef !== planJobRef ||
      manifest.tenantId !== this.policy.tenantId ||
      manifest.subscriptionId !== this.policy.subscriptionId ||
      canonicalPlanManifest(manifest).length > 64 * 1_024
    ) {
      throw new InfrastructureApprovalError("manifest-authority-mismatch");
    }
    validateBackend(manifest.backend, "manifest.backend");
    if (!sameBackend(manifest.backend, this.policy.backend)) {
      throw new InfrastructureApprovalError("backend-mismatch");
    }
  }

  private async recheckBeforeAuthority(input: {
    readonly approvalRunId: string;
    readonly artifact: ArtifactTimeEvidence;
    readonly inputs: ApprovalInputs;
    readonly manifestCreatedAt: string;
    readonly manifestExpiresAt: string;
  }): Promise<void> {
    const [approvalRun, planRun, main, activationBytes] = await Promise.all([
      this.github.getRun(input.approvalRunId),
      this.github.getRun(input.inputs.planRunId),
      this.github.getCurrentMainSha(),
      this.github.getActivationConfiguration(input.inputs.commitSha),
    ]);
    requireCommittedActivationConfiguration(this.policy, activationBytes);
    this.verifyRuns(approvalRun, planRun, input.approvalRunId, input.inputs);
    const now = this.now();
    if (main !== input.inputs.commitSha) throw new InfrastructureApprovalError("main-moved");
    requireFreshApproval(approvalRun.createdAt, now);
    requirePlanFresh(input.manifestCreatedAt, input.manifestExpiresAt, now);
    verifyApprovalChronology({
      approvalRun,
      artifact: input.artifact,
      manifestCreatedAt: input.manifestCreatedAt,
      now,
      planRun,
    });
  }

  private async applyUnderLease(input: {
    readonly approvalRunId: string;
    readonly artifact: ArtifactTimeEvidence;
    readonly bundle: VerifiedPlanBundle;
    readonly currentState: StateIdentity;
    readonly inputs: ApprovalInputs;
    readonly lease: ApplyLeaseEvidence;
    readonly session: InfrastructureIdentitySession;
    readonly transientRawToken: Uint8Array;
  }): Promise<ApplyEngineResult> {
    const proposed = startedIntentFor({
      approvalRunId: input.approvalRunId,
      bundle: input.bundle,
      inputs: input.inputs,
      startedAt: this.now().toISOString(),
    });
    const previouslyStored = await this.intents.read({
      planDigest: input.bundle.planDigest,
      session: input.session,
    });
    if (previouslyStored !== null) {
      validateIntentReceipt(previouslyStored);
      requireSameIntent(previouslyStored, proposed);
      if (previouslyStored.status !== "completed") {
        throw new InfrastructureApprovalError(`intent-${previouslyStored.status}-requires-replan`);
      }
      requireCompletedProof(previouslyStored, input.currentState, input.bundle.planDigest);
      return resultFromCompleted(previouslyStored, true);
    }
    requireState(input.currentState, input.bundle.manifest.state, "state-changed-since-plan");
    const existing = await this.intents.createStarted({ proposed, session: input.session });
    validateIntentReceipt(existing.receipt);
    requireSameIntent(existing.receipt, proposed);
    if (existing.outcome === "exists") {
      if (existing.receipt.status !== "completed") {
        throw new InfrastructureApprovalError(`intent-${existing.receipt.status}-requires-replan`);
      }
      requireCompletedProof(existing.receipt, input.currentState, input.bundle.planDigest);
      return resultFromCompleted(existing.receipt, true);
    }
    if (
      existing.receipt.status !== "started" ||
      existing.receipt.receiptDigest !== proposed.receiptDigest
    ) {
      throw new InfrastructureApprovalError("created-intent-proof-mismatch");
    }

    // This check is deliberately after the durable started receipt. Any
    // failure strands the intent so the reviewed plan can never be replayed.
    await this.recheckBeforeAuthority({
      approvalRunId: input.approvalRunId,
      artifact: input.artifact,
      inputs: input.inputs,
      manifestCreatedAt: input.bundle.manifest.createdAt,
      manifestExpiresAt: input.bundle.manifest.expiresAt,
    });
    const finalState = await this.state.readIdentityUnderLease({
      backend: this.policy.backend,
      lease: input.lease,
      session: input.session,
    });
    requireState(finalState, input.currentState, "state-changed-before-apply-capability");
    assertExactSavedPlanApplyCommand(EXACT_SAVED_PLAN_APPLY_COMMAND);
    let execution: Awaited<ReturnType<ApplyExecutionPort["applyExactSavedPlan"]>>;
    try {
      execution = await this.applier.applyExactSavedPlan({
        authorityClass: input.bundle.manifest.authorityClass,
        command: EXACT_SAVED_PLAN_APPLY_COMMAND,
        savedPlan: Uint8Array.from(input.bundle.savedPlan),
        session: input.session,
        transientGitHubOidcToken: input.transientRawToken,
      });
    } catch {
      const unknown = finishIntent(existing.receipt, {
        finishedAt: this.now().toISOString(),
        resultDigest: sha256Text("unknown-apply-result"),
        status: "unknown",
      });
      await this.storeTerminal(existing.receipt, unknown, input.bundle.planDigest, input.session);
      throw new InfrastructureApprovalError("apply-result-unknown-replan-required");
    }
    if (
      !["completed", "failed", "native-lock-failed", "partial", "stale-plan"].includes(
        execution.outcome,
      )
    ) {
      const unknown = finishIntent(existing.receipt, {
        finishedAt: this.now().toISOString(),
        resultDigest: sha256Text("unrecognised-apply-result"),
        status: "unknown",
      });
      await this.storeTerminal(existing.receipt, unknown, input.bundle.planDigest, input.session);
      throw new InfrastructureApprovalError("apply-result-unrecognised-replan-required");
    }
    if (execution.outcome !== "completed") {
      sha256(execution.resultDigest, "apply.resultDigest");
      const terminal = finishIntent(existing.receipt, {
        finishedAt: this.now().toISOString(),
        resultDigest: execution.resultDigest,
        status: execution.outcome,
      });
      await this.storeTerminal(existing.receipt, terminal, input.bundle.planDigest, input.session);
      throw new InfrastructureApprovalError(`apply-${execution.outcome}-replan-required`);
    }
    if (execution.appliedPlanDigest !== input.bundle.planDigest) {
      const unknown = finishIntent(existing.receipt, {
        finishedAt: this.now().toISOString(),
        resultDigest: sha256Text("applier-used-wrong-plan"),
        status: "unknown",
      });
      await this.storeTerminal(existing.receipt, unknown, input.bundle.planDigest, input.session);
      throw new InfrastructureApprovalError("applier-used-wrong-plan");
    }
    sha256(execution.resultDigest, "apply.resultDigest");
    validateStateIdentity(execution.stateAfter, "apply.stateAfter");
    const stateShouldChange =
      input.bundle.manifest.changeSummary.create > 0 ||
      input.bundle.manifest.changeSummary.update > 0 ||
      input.bundle.manifest.changeSummary.delete > 0;
    if (
      execution.stateAfter.lineage !== input.currentState.lineage ||
      execution.stateAfter.serial < input.currentState.serial ||
      (stateShouldChange &&
        (execution.stateAfter.serial <= input.currentState.serial ||
          execution.stateAfter.backendStateDigest === input.currentState.backendStateDigest)) ||
      (input.bundle.manifest.authorityClass === "bootstrap" &&
        (execution.stateAfter.managedResourcesEmpty ||
          execution.stateAfter.managedResourceCount < 1))
    ) {
      const unknown = finishIntent(existing.receipt, {
        finishedAt: this.now().toISOString(),
        resultDigest: sha256Text("apply-state-proof-invalid"),
        status: "unknown",
      });
      await this.storeTerminal(existing.receipt, unknown, input.bundle.planDigest, input.session);
      throw new InfrastructureApprovalError("apply-state-proof-invalid");
    }
    const completed = finishIntent(existing.receipt, {
      appliedPlanDigest: execution.appliedPlanDigest,
      finishedAt: this.now().toISOString(),
      resultDigest: execution.resultDigest,
      stateAfter: execution.stateAfter,
      status: "completed",
    });
    const stored = await this.intents.replace({
      expectedReceiptDigest: existing.receipt.receiptDigest,
      next: completed,
      planDigest: input.bundle.planDigest,
      session: input.session,
    });
    validateIntentReceipt(stored);
    requireSameIntent(stored, proposed);
    if (stored.status !== "completed")
      throw new InfrastructureApprovalError("completion-proof-missing");
    requireCompletedProof(stored, execution.stateAfter, input.bundle.planDigest);
    return resultFromCompleted(stored, false);
  }

  private async storeTerminal(
    started: StartedApplyIntentReceipt,
    terminal: ApplyIntentReceipt,
    planDigest: string,
    session: InfrastructureIdentitySession,
  ): Promise<void> {
    const stored = await this.intents.replace({
      expectedReceiptDigest: started.receiptDigest,
      next: terminal,
      planDigest,
      session,
    });
    validateIntentReceipt(stored);
    if (stored.status === "started" || stored.status === "completed") {
      throw new InfrastructureApprovalError("terminal-intent-proof-missing");
    }
  }
}

export function assertExactSavedPlanApplyCommand(command: readonly string[]): void {
  if (
    command.length !== EXACT_SAVED_PLAN_APPLY_COMMAND.length ||
    command.some((part, index) => part !== EXACT_SAVED_PLAN_APPLY_COMMAND[index]) ||
    command.some((part) =>
      /(^|[=])(destroy|target|replace|plan|refresh-only|lock=false)(=|$)/.test(part),
    )
  ) {
    throw new InfrastructureApprovalError("apply-command-not-exact-saved-plan-only");
  }
}

export function makeIntent(value: ApplyIntentBody): ApplyIntentReceipt {
  return Object.freeze({
    ...value,
    receiptDigest: sha256Text(canonicalIntentBody(value)),
  }) as ApplyIntentReceipt;
}

function startedIntentFor(input: {
  readonly approvalRunId: string;
  readonly bundle: VerifiedPlanBundle;
  readonly inputs: ApprovalInputs;
  readonly startedAt: string;
}): StartedApplyIntentReceipt {
  return makeIntent({
    approvalRunId: input.approvalRunId,
    archiveDigest: input.bundle.archiveDigest,
    artifactId: input.inputs.artifactId,
    authorityClass: input.bundle.manifest.authorityClass,
    commandDigest: sha256Text(`${JSON.stringify(EXACT_SAVED_PLAN_APPLY_COMMAND)}\n`),
    commitSha: input.inputs.commitSha,
    manifestDigest: input.bundle.manifestDigest,
    planDigest: input.bundle.planDigest,
    planRunId: input.inputs.planRunId,
    savedPlanDigest: sha256Bytes(input.bundle.savedPlan),
    startedAt: input.startedAt,
    stateBefore: input.bundle.manifest.state,
    status: "started",
  }) as StartedApplyIntentReceipt;
}

export function validateIntentReceipt(receipt: ApplyIntentReceipt): void {
  const status = (receipt as { readonly status: unknown }).status;
  if (
    typeof status !== "string" ||
    ![
      "completed",
      "failed",
      "native-lock-failed",
      "partial",
      "stale-plan",
      "started",
      "unknown",
    ].includes(status)
  ) {
    throw new InfrastructureApprovalError("intent-status-invalid");
  }
  const keys = [
    "approvalRunId",
    "archiveDigest",
    "artifactId",
    "authorityClass",
    "commandDigest",
    "commitSha",
    "manifestDigest",
    "planDigest",
    "planRunId",
    "savedPlanDigest",
    "startedAt",
    "stateBefore",
    "status",
    "receiptDigest",
  ];
  if (receipt.status !== "started") keys.push("finishedAt", "resultDigest");
  if (receipt.status === "completed") keys.push("appliedPlanDigest", "stateAfter");
  requireExactKeys(requireRecord(receipt, "intent"), keys, "intent");
  const started = instant(receipt.startedAt, "intent.startedAt");
  validateStateIdentity(receipt.stateBefore, "intent.stateBefore");
  if (receipt.status !== "started") {
    const finished = instant(receipt.finishedAt, "intent.finishedAt");
    if (finished.getTime() < started.getTime()) {
      throw new InfrastructureApprovalError("intent-finished-before-started");
    }
    sha256(receipt.resultDigest, "intent.resultDigest");
  }
  if (receipt.status === "completed") {
    validateStateIdentity(receipt.stateAfter, "intent.stateAfter");
    sha256(receipt.appliedPlanDigest, "intent.appliedPlanDigest");
  }
  if (receipt.receiptDigest !== sha256Text(canonicalIntentBody(receipt))) {
    throw new InfrastructureApprovalError("intent-receipt-digest-mismatch");
  }
}

function canonicalIntentBody(value: ApplyIntentBody | ApplyIntentReceipt): string {
  const body: Record<string, unknown> = {
    approval_run_id: value.approvalRunId,
    plan_run_id: value.planRunId,
    artifact_id: value.artifactId,
    commit_sha: value.commitSha,
    plan_digest: value.planDigest,
    archive_digest: value.archiveDigest,
    manifest_digest: value.manifestDigest,
    saved_plan_digest: value.savedPlanDigest,
    authority_class: value.authorityClass,
    command_digest: value.commandDigest,
    state_before: stateJson(value.stateBefore),
    started_at: value.startedAt,
    status: value.status,
  };
  if (value.status !== "started") {
    body.finished_at = value.finishedAt;
    body.result_digest = value.resultDigest;
  }
  if (value.status === "completed") {
    body.applied_plan_digest = value.appliedPlanDigest;
    body.state_after = stateJson(value.stateAfter);
  }
  return `${JSON.stringify(body)}\n`;
}

function finishIntent(
  started: StartedApplyIntentReceipt,
  finish:
    | {
        readonly finishedAt: string;
        readonly resultDigest: string;
        readonly status: ApplyTerminalFailure | "unknown";
      }
    | {
        readonly appliedPlanDigest: string;
        readonly finishedAt: string;
        readonly resultDigest: string;
        readonly stateAfter: StateIdentity;
        readonly status: "completed";
      },
): ApplyIntentReceipt {
  const { receiptDigest: _receiptDigest, ...base } = started;
  return makeIntent({ ...base, ...finish } as ApplyIntentBody);
}

function requireSameIntent(actual: ApplyIntentReceipt, expected: ApplyIntentReceipt): void {
  for (const field of [
    "approvalRunId",
    "archiveDigest",
    "artifactId",
    "authorityClass",
    "commandDigest",
    "commitSha",
    "manifestDigest",
    "planDigest",
    "planRunId",
    "savedPlanDigest",
  ] as const) {
    if (actual[field] !== expected[field]) throw new InfrastructureApprovalError("intent-conflict");
  }
  requireState(actual.stateBefore, expected.stateBefore, "intent-state-conflict");
}

function requireCompletedProof(
  receipt: ApplyIntentReceipt & { readonly status: "completed" },
  state: StateIdentity,
  planDigest: string,
): void {
  if (receipt.appliedPlanDigest !== planDigest) {
    throw new InfrastructureApprovalError("completed-intent-plan-proof-mismatch");
  }
  sha256(receipt.resultDigest, "intent.resultDigest");
  requireState(state, receipt.stateAfter, "completed-intent-state-proof-mismatch");
}

function resultFromCompleted(
  receipt: ApplyIntentReceipt & { readonly status: "completed" },
  replayed: boolean,
): ApplyEngineResult {
  return Object.freeze({
    planDigest: receipt.planDigest,
    receiptDigest: receipt.receiptDigest,
    replayed,
    resultDigest: receipt.resultDigest,
    status: "completed",
  });
}

function identityFor(authority: PlanAuthorityClass): DeploymentIdentityClass {
  return authority === "bootstrap" ? "bootstrap-applier" : "foundation-applier";
}

function requireState(actual: StateIdentity, expected: StateIdentity, code: string): void {
  validateStateIdentity(actual, "state.actual");
  validateStateIdentity(expected, "state.expected");
  if (!sameState(actual, expected)) throw new InfrastructureApprovalError(code);
}

function sameState(left: StateIdentity, right: StateIdentity): boolean {
  return (
    left.backendStateDigest === right.backendStateDigest &&
    left.backendStateEtag === right.backendStateEtag &&
    left.lineage === right.lineage &&
    left.managedResourceCount === right.managedResourceCount &&
    left.managedResourcesEmpty === right.managedResourcesEmpty &&
    left.serial === right.serial
  );
}

function sameBackend(left: BackendIdentity, right: BackendIdentity): boolean {
  return (
    left.type === right.type &&
    left.resourceGroupName === right.resourceGroupName &&
    left.storageAccountName === right.storageAccountName &&
    left.containerName === right.containerName &&
    left.key === right.key
  );
}

function sameSummary(left: PlanChangeSummary, right: PlanChangeSummary): boolean {
  return (
    left.authority === right.authority &&
    left.create === right.create &&
    left.delete === right.delete &&
    left.read === right.read &&
    left.replace === right.replace &&
    left.update === right.update
  );
}

function stateJson(value: StateIdentity): Record<string, unknown> {
  return {
    backend_state_sha256: value.backendStateDigest,
    backend_state_etag: value.backendStateEtag,
    lineage: value.lineage,
    managed_resource_count: value.managedResourceCount,
    managed_resources_empty: value.managedResourcesEmpty,
    serial: value.serial,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function verifyReceiptEvidence(
  receipt: {
    readonly createdAt: string;
    readonly etag: string;
    readonly publishedAt: string;
  },
  now: Date,
): void {
  const created = instant(receipt.createdAt, "receipt.createdAt").getTime();
  const published = instant(receipt.publishedAt, "receipt.publishedAt").getTime();
  stateEtag(receipt.etag, "receipt.etag");
  if (created > published || published > now.getTime()) {
    throw new InfrastructureApprovalError("private-receipt-chronology-invalid");
  }
}
