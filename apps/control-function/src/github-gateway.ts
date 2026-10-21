import type { AllocationIdentity } from "@switchyard/core";
import type { AzureRunnerGitHubPort, ExactRunnerObservation } from "@switchyard/azure-worker";
import type {
  GitHubWorkloadObservationPort,
  LifecycleVisibilityPort,
} from "@switchyard/reconciler";

/**
 * Safety starts without admission credentials. Installing GitHub capabilities
 * later can improve registration cleanup, but Azure cleanup never waits for it.
 */
export class DeferredGitHubSafetyGateway
  implements AzureRunnerGitHubPort, GitHubWorkloadObservationPort, LifecycleVisibilityPort
{
  readonly #load: () => Promise<GitHubSafetyCapabilities>;
  #capabilities: Promise<GitHubSafetyCapabilities> | null = null;

  constructor(load: () => Promise<GitHubSafetyCapabilities>) {
    this.#load = load;
  }

  async fenceRunner(input: {
    readonly runnerLabel: string;
    readonly runnerRegistrationId: string | null;
  }) {
    return (await this.#required()).runner.fenceRunner(input);
  }

  async mintJitConfiguration(input: {
    readonly allocationId: string;
    readonly runnerLabel: string;
  }) {
    return (await this.#required()).runner.mintJitConfiguration(input);
  }

  async observeExactRunner(input: {
    readonly runnerLabel: string;
  }): Promise<ExactRunnerObservation> {
    return (await this.#required()).runner.observeExactRunner(input);
  }

  async getRun(
    identity: AllocationIdentity,
    options: { readonly signal: AbortSignal },
  ): Promise<unknown> {
    return (await this.#required()).workload.getRun(identity, options);
  }

  async listJobs(input: {
    readonly continuationToken?: string;
    readonly identity: AllocationIdentity;
    readonly pageSize: number;
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    return (await this.#required()).workload.listJobs(input);
  }

  async reconcile(allocationId: string, options: { readonly signal: AbortSignal }): Promise<void> {
    return (await this.#required()).visibility.reconcile(allocationId, options);
  }

  async #required(): Promise<GitHubSafetyCapabilities> {
    let loading = this.#capabilities;
    if (loading === null) {
      loading = this.#load();
      this.#capabilities = loading;
    }
    try {
      return await loading;
    } catch {
      if (this.#capabilities === loading) this.#capabilities = null;
      throw new TypeError("GitHub safety capabilities are unavailable");
    }
  }
}

export interface GitHubSafetyCapabilities {
  readonly runner: AzureRunnerGitHubPort;
  readonly visibility: LifecycleVisibilityPort;
  readonly workload: GitHubWorkloadObservationPort;
}
