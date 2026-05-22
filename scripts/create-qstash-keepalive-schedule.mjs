import '../src/config/env.js';
import {
  buildKeepAliveScheduleRequest,
  createKeepAliveSchedule,
  getQstashStatus,
} from '../src/config/qstash.js';

try {
  const status = getQstashStatus();
  if (!status.clientConfigured) {
    throw new Error('QSTASH_TOKEN is missing.');
  }
  if (!status.renderBackendUrlConfigured) {
    throw new Error('RENDER_BACKEND_URL is missing.');
  }

  const request = buildKeepAliveScheduleRequest();
  const result = await createKeepAliveSchedule();

  console.log(JSON.stringify({
    success: true,
    schedule: result,
    request: {
      destination: request.destination,
      failureCallback: request.failureCallback,
      cron: request.cron,
      retries: request.retries,
      timeout: request.timeout,
      scheduleId: request.scheduleId,
      label: request.label,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    success: false,
    message: error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
}
