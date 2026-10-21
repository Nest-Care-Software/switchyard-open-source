import {
  parseProviderAttemptResult,
  type ProviderAdapter,
  type ProviderAllocationRequest,
  type ProviderAllocationRequestFor,
  type ProviderAttemptResultFor,
  type ProviderName,
  type RunnerKindForProvider,
} from "../provider.js";

export class FakeProviderAdapter<P extends ProviderName> implements ProviderAdapter<P> {
  readonly name: P;
  readonly requests: ProviderAllocationRequest[] = [];
  readonly runnerKind: RunnerKindForProvider<P>;
  readonly #results: unknown[];

  constructor(name: P, results: readonly unknown[]) {
    this.name = name;
    this.runnerKind = (
      name === "azure" ? "ephemeral" : "managed-label"
    ) as RunnerKindForProvider<P>;
    this.#results = [...results];
  }

  async allocate(request: ProviderAllocationRequestFor<P>): Promise<ProviderAttemptResultFor<P>> {
    this.requests.push(request);

    const rawResult = this.#results.shift();
    if (rawResult === undefined) {
      throw new Error(`Fake ${this.name} provider has no queued result`);
    }

    const result = parseProviderAttemptResult(rawResult);
    if (result.provider !== this.name) {
      throw new Error(`Fake ${this.name} provider received a result for ${result.provider}`);
    }

    return result as ProviderAttemptResultFor<P>;
  }
}
