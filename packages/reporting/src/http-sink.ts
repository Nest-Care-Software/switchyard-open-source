import {
  deliverUsageRecordBestEffort,
  parseIdempotencyKey,
  type BestEffortDeliveryOptions,
  type BestEffortDeliveryResult,
  type DeliveryClock,
  type UsageRecordSink,
  type UsageRecordWriteResult,
} from "./delivery.js";
import {
  createUsageRecordContract,
  V1_USAGE_RECORD_CONTRACT,
  type ApprovedReportingDimensions,
  type UsageRecord,
} from "./usage-record.js";

export interface ReportingAccessCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface ReportingHttpSinkOptions {
  readonly approvedDimensions?: readonly ApprovedReportingDimensions[];
  readonly baseUrl: string;
  readonly clock?: DeliveryClock;
  readonly credentials: ReportingAccessCredentials;
  readonly fetch?: typeof fetch;
  readonly maximumAttempts?: number;
  readonly overallTimeoutMilliseconds?: number;
  readonly perAttemptTimeoutMilliseconds?: number;
}

export interface ReportingHttpDeliveryOptions {
  readonly signal?: AbortSignal;
}

export interface ReportingHttpSink {
  deliver(
    idempotencyKey: string,
    value: unknown,
    options?: ReportingHttpDeliveryOptions,
  ): Promise<BestEffortDeliveryResult>;
}

export function createReportingHttpSink(options: ReportingHttpSinkOptions): ReportingHttpSink {
  const endpoint = usageRecordEndpoint(options.baseUrl);
  const clientId = requireCredential(options.credentials.clientId, "Access client ID");
  const clientSecret = requireCredential(options.credentials.clientSecret, "Access client secret");
  const fetchImplementation = options.fetch ?? fetch;
  const usageRecordContract =
    options.approvedDimensions === undefined
      ? V1_USAGE_RECORD_CONTRACT
      : createUsageRecordContract(options.approvedDimensions);

  const rawSink: UsageRecordSink = {
    async write(
      idempotencyKey: string,
      record: UsageRecord,
      context,
    ): Promise<UsageRecordWriteResult> {
      const response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": clientId,
          "CF-Access-Client-Secret": clientSecret,
          "Content-Type": "application/json",
          "Idempotency-Key": parseIdempotencyKey(idempotencyKey),
        },
        body: usageRecordContract.canonicalJson(record),
        signal: context.signal,
      });

      if (response.status === 201) {
        return "stored";
      }
      if (response.status === 200) {
        return "replayed";
      }
      if (response.status === 409) {
        return "conflict";
      }
      throw new Error(`reporting telemetry returned HTTP ${response.status}`);
    },
  };

  const deliveryDefaults: BestEffortDeliveryOptions = {
    approvedDimensions: usageRecordContract.approvedDimensions,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.maximumAttempts === undefined ? {} : { maximumAttempts: options.maximumAttempts }),
    ...(options.overallTimeoutMilliseconds === undefined
      ? {}
      : { overallTimeoutMilliseconds: options.overallTimeoutMilliseconds }),
    ...(options.perAttemptTimeoutMilliseconds === undefined
      ? {}
      : { perAttemptTimeoutMilliseconds: options.perAttemptTimeoutMilliseconds }),
  };

  return Object.freeze({
    deliver(
      idempotencyKey: string,
      value: unknown,
      deliveryOptions: ReportingHttpDeliveryOptions = {},
    ): Promise<BestEffortDeliveryResult> {
      return deliverUsageRecordBestEffort(rawSink, idempotencyKey, value, {
        ...deliveryDefaults,
        ...(deliveryOptions.signal === undefined ? {} : { signal: deliveryOptions.signal }),
      });
    },
  });
}

function usageRecordEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("reporting base URL must be an HTTPS URL without credentials or a query");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/usage-records`;
  return url;
}

function requireCredential(value: string, name: string): string {
  if (value.length === 0) {
    throw new TypeError(`${name} is required at runtime`);
  }
  return value;
}
