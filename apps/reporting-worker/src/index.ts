import { handleRequest, handleScheduled, type ReportingWorkerEnvironment } from "./worker.js";

interface ScheduledControllerLike {
  readonly cron: string;
  readonly scheduledTime: number;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  fetch(request: Request, environment: ReportingWorkerEnvironment): Promise<Response> {
    return handleRequest(request, environment);
  },

  async scheduled(
    controller: ScheduledControllerLike,
    environment: ReportingWorkerEnvironment,
    context: ExecutionContextLike,
  ): Promise<void> {
    context.waitUntil(
      handleScheduled(
        { cron: controller.cron, scheduledTime: controller.scheduledTime },
        environment,
      ),
    );
  },
};
