import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type AzureRecoveryTransport,
  type GitHubRecoveryPort,
  type RecoveryHttpResponse,
  RecoverySafetyError,
} from "@switchyard/recovery";

const execFileAsync = promisify(execFile);
const ORGANISATION = "example-org";

export class AzureCliRecoveryTransport implements AzureRecoveryTransport {
  readonly #fetch: typeof fetch;
  readonly #subscriptionId: string;
  #token: Promise<string> | null = null;

  constructor(options: { readonly fetch?: typeof fetch; readonly subscriptionId: string }) {
    this.#fetch = options.fetch ?? fetch;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(options.subscriptionId)) {
      throw new RecoverySafetyError("subscription ID must be a canonical lowercase UUID");
    }
    this.#subscriptionId = options.subscriptionId;
  }

  async request(input: {
    readonly method: "DELETE" | "GET" | "POST";
    readonly path: string;
  }): Promise<RecoveryHttpResponse> {
    if (!input.path.startsWith(`/subscriptions/${this.#subscriptionId}/`)) {
      throw new RecoverySafetyError("Azure request escaped the exact subscription");
    }
    if (this.#token === null) this.#token = this.#loadToken();
    const token = await this.#token;
    const response = await this.#fetch(`https://management.azure.com${input.path}`, {
      headers: { Authorization: `Bearer ${token}` },
      method: input.method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (text.length > 512 * 1024)
      throw new RecoverySafetyError("Azure response exceeded its bound");
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new RecoverySafetyError("Azure returned malformed JSON");
      }
    }
    return { body, status: response.status };
  }

  async #loadToken(): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "az",
        [
          "account",
          "get-access-token",
          "--subscription",
          this.#subscriptionId,
          "--resource",
          "https://management.azure.com/",
          "--output",
          "json",
          "--only-show-errors",
        ],
        { encoding: "utf8", maxBuffer: 256 * 1024, timeout: 10_000 },
      ));
    } catch {
      throw new RecoverySafetyError("Azure CLI authentication failed");
    }
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new RecoverySafetyError("Azure CLI returned malformed authentication evidence");
    }
    const token = record(value).accessToken;
    if (typeof token !== "string" || token.length < 32 || token.length > 16_384) {
      throw new RecoverySafetyError("Azure CLI returned invalid authentication evidence");
    }
    return token;
  }
}

export class ReducedGitHubRecoveryPort implements GitHubRecoveryPort {
  readonly #fetch: typeof fetch;
  readonly #token: string;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(options: {
    readonly fetch?: typeof fetch;
    readonly token: string;
    readonly wait?: (milliseconds: number) => Promise<void>;
  }) {
    if (options.token.length < 32 || options.token.length > 16_384) {
      throw new RecoverySafetyError("reduced GitHub runner token is invalid");
    }
    this.#fetch = options.fetch ?? fetch;
    this.#token = options.token;
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async fenceExactRunnerLabel(input: { readonly runnerLabel: string }) {
    if (!/^switchyard-sy1-[a-f0-9]{64}$/.test(input.runnerLabel)) {
      throw new RecoverySafetyError("recovery runner label is invalid");
    }
    let registrationsDeleted = 0;
    let absenceScans = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      if (pass > 0) await this.#wait(2_000);
      const matches = await this.#matchingRunners(input.runnerLabel);
      if (matches.length === 0) {
        absenceScans += 1;
        if (absenceScans === 2) return { registrationsDeleted, runnerLabel: input.runnerLabel };
        continue;
      }
      absenceScans = 0;
      for (const id of matches) {
        const response = await this.#request(
          "DELETE",
          `/orgs/${ORGANISATION}/actions/runners/${id}`,
        );
        if (response.status !== 204) throw new RecoverySafetyError("GitHub runner deletion failed");
        registrationsDeleted += 1;
      }
    }
    throw new RecoverySafetyError("GitHub runner absence could not be proved");
  }

  async #matchingRunners(expectedLabel: string): Promise<readonly string[]> {
    const matches: string[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 20; page += 1) {
      const response = await this.#request(
        "GET",
        `/orgs/${ORGANISATION}/actions/runners?per_page=100&page=${page}`,
      );
      if (response.status !== 200) throw new RecoverySafetyError("GitHub runner lookup failed");
      let value: unknown;
      try {
        const text = await response.text();
        if (text.length > 512 * 1024) {
          throw new RecoverySafetyError("GitHub runner response exceeded its bound");
        }
        value = JSON.parse(text);
      } catch {
        throw new RecoverySafetyError("GitHub returned malformed runner data");
      }
      const envelope = record(value);
      if (!Array.isArray(envelope.runners) || envelope.runners.length > 100) {
        throw new RecoverySafetyError("GitHub runner page is invalid");
      }
      for (const raw of envelope.runners) {
        const runner = record(raw);
        if (!Array.isArray(runner.labels) || runner.labels.length > 100) {
          throw new RecoverySafetyError("GitHub runner labels are invalid");
        }
        const labels = runner.labels.map((entry) => bounded(record(entry).name, "runner label"));
        const switchyard = labels.filter((label) => /^switchyard/i.test(label));
        if (
          switchyard.some((label) => !/^switchyard-sy1-[a-f0-9]{64}$/i.test(label)) ||
          switchyard.length > 1
        ) {
          throw new RecoverySafetyError("GitHub runner has ambiguous Switchyard labels");
        }
        if (switchyard[0]?.toLowerCase() !== expectedLabel) continue;
        const id = positiveDecimal(runner.id);
        if (seen.has(id))
          throw new RecoverySafetyError("GitHub runner enumeration duplicated an ID");
        seen.add(id);
        matches.push(id);
      }
      if (envelope.runners.length < 100) return Object.freeze(matches);
    }
    throw new RecoverySafetyError("GitHub runner enumeration exceeded its safe bound");
  }

  #request(method: "DELETE" | "GET", path: string) {
    return this.#fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#token}`,
        "user-agent": "switchyard-owner-recovery",
        "x-github-api-version": "2022-11-28",
      },
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecoverySafetyError("provider returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function bounded(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new RecoverySafetyError(`${name} is invalid`);
  }
  return value;
}

function positiveDecimal(value: unknown): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RecoverySafetyError("GitHub runner ID is invalid");
  }
  const normalised = typeof value === "number" ? String(value) : value;
  if (typeof normalised !== "string" || !/^[1-9][0-9]{0,19}$/.test(normalised)) {
    throw new RecoverySafetyError("GitHub runner ID is invalid");
  }
  return normalised;
}
