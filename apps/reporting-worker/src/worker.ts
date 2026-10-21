import {
  createWeeklyReportPayload,
  parseIdempotencyKey,
  parseReportWindowDays,
  parseUsageRecord,
  UsageRecordValidationError,
  type WeeklyReportPayload,
} from "@switchyard/reporting";

import { AccessJwtError, validateAccessRequest, type AccessJwtDependencies } from "./auth.js";
import { D1ReportingStore, type D1DatabaseLike } from "./d1-store.js";

const MAXIMUM_USAGE_BODY_BYTES = 16 * 1_024;
export const RETENTION_CRON = "15 2 * * *";
export const WEEKLY_REPORT_CRON = "0 8 * * MON";

export interface ReportingWorkerEnvironment {
  readonly ACCESS_AUDIENCE: string;
  readonly ACCESS_ISSUER: string;
  readonly REPORTING_DB: D1DatabaseLike;
  readonly WEEKLY_REPORT_SINK?: WeeklyReportSink;
}

export interface WeeklyReportSink {
  send(payload: WeeklyReportPayload): Promise<void>;
}

export interface ScheduledEventLike {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface ReportingWorkerDependencies {
  readonly accessJwt?: AccessJwtDependencies;
  readonly now?: Date;
}

export async function handleRequest(
  request: Request,
  environment: ReportingWorkerEnvironment,
  dependencies: ReportingWorkerDependencies = {},
): Promise<Response> {
  try {
    await validateAccessRequest(
      request,
      {
        issuer: environment.ACCESS_ISSUER,
        audience: environment.ACCESS_AUDIENCE,
      },
      dependencies.accessJwt,
    );
  } catch (error) {
    if (error instanceof AccessJwtError) {
      return jsonResponse(401, { error: "access_denied" });
    }
    return jsonResponse(401, { error: "access_denied" });
  }

  const url = new URL(request.url);
  if (url.search !== "") {
    return jsonResponse(400, { error: "query_parameters_not_supported" });
  }

  const store = new D1ReportingStore(environment.REPORTING_DB);
  try {
    if (request.method === "POST" && url.pathname === "/v1/usage-records") {
      return await writeUsageRecord(request, store);
    }

    const reportMatch = /^\/v1\/reports\/(7|30|365)$/.exec(url.pathname);
    if (request.method === "GET" && reportMatch !== null) {
      const windowDays = parseReportWindowDays(reportMatch[1]);
      const report = await store.buildReport(windowDays, dependencies.now ?? new Date());
      return jsonResponse(200, report);
    }

    if (url.pathname.startsWith("/v1/reports/") || url.pathname === "/v1/usage-records") {
      return jsonResponse(405, { error: "operation_not_supported" });
    }
    return jsonResponse(404, { error: "operation_not_found" });
  } catch {
    return jsonResponse(503, { error: "reporting_unavailable" });
  }
}

export async function handleScheduled(
  event: ScheduledEventLike,
  environment: ReportingWorkerEnvironment,
): Promise<WeeklyReportPayload | undefined> {
  const store = new D1ReportingStore(environment.REPORTING_DB);
  const scheduledAt = new Date(event.scheduledTime);

  if (event.cron === RETENTION_CRON) {
    await store.runRetention(scheduledAt);
    return undefined;
  }
  if (event.cron === WEEKLY_REPORT_CRON) {
    const payload = createWeeklyReportPayload(await store.buildReport(7, scheduledAt));
    await environment.WEEKLY_REPORT_SINK?.send(payload);
    return payload;
  }
  throw new Error("unrecognised reporting schedule");
}

async function writeUsageRecord(request: Request, store: D1ReportingStore): Promise<Response> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonResponse(415, { error: "content_type_not_supported" });
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) > MAXIMUM_USAGE_BODY_BYTES) {
    return jsonResponse(413, { error: "request_too_large" });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_USAGE_BODY_BYTES) {
    return jsonResponse(413, { error: "request_too_large" });
  }
  let record: ReturnType<typeof parseUsageRecord>;
  let idempotencyKey: string;
  try {
    record = parseUsageRecord(JSON.parse(body));
    idempotencyKey = parseIdempotencyKey(request.headers.get("Idempotency-Key"));
  } catch (error) {
    if (
      error instanceof UsageRecordValidationError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    ) {
      return jsonResponse(400, { error: "invalid_request" });
    }
    throw error;
  }
  const outcome = await store.writeUsageRecord(idempotencyKey, record);

  if (outcome === "created") {
    return jsonResponse(201, { status: "created" });
  }
  if (outcome === "replayed") {
    return jsonResponse(200, { status: "replayed" });
  }
  return jsonResponse(409, { error: "idempotency_conflict" });
}

function jsonResponse(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
