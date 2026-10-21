import { app } from "@azure/functions";

import {
  allocationHttp,
  provisionAllocation,
  provisioningPoison,
  reconcileAllocations,
} from "./functions.js";
import { createProductionRuntime } from "./production.js";

let runtime: ReturnType<typeof createProductionRuntime> | null = null;

function requiredRuntime() {
  runtime ??= createProductionRuntime(process.env);
  return runtime;
}

app.http("allocate", {
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      return await allocationHttp(request, context, await requiredRuntime());
    } catch {
      context.error(
        JSON.stringify({
          event: "switchyard-safety-incident",
          result_code: "runtime-unavailable",
          stage_code: "allocation-http",
        }),
      );
      return {
        body: JSON.stringify({ error: "controller-unavailable" }),
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "5",
          "X-Content-Type-Options": "nosniff",
        },
        status: 503,
      };
    }
  },
  methods: ["POST"],
  route: "v1/allocations",
});

app.storageQueue("provisionAzure", {
  connection: "AzureWebJobsStorage",
  handler: async (message, context) =>
    provisionAllocation(message, context, await requiredRuntime()),
  queueName: "%SWITCHYARD_PROVISIONING_QUEUE%",
});

app.storageQueue("provisionAzurePoison", {
  connection: "AzureWebJobsStorage",
  handler: async (message, context) =>
    provisioningPoison(message, context, await requiredRuntime()),
  queueName: "%SWITCHYARD_PROVISIONING_POISON_QUEUE%",
});

app.timer("reconcile", {
  handler: async (timer, context) => reconcileAllocations(timer, context, await requiredRuntime()),
  runOnStartup: false,
  schedule: "0 * * * * *",
  useMonitor: true,
});
