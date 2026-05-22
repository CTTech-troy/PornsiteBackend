import '../src/config/env.js';
import { createMonitoringWorkflowSchedules } from '../src/config/qstash.js';

try {
  const schedules = await createMonitoringWorkflowSchedules();
  console.log('Created or updated QStash API monitoring schedules:');
  for (const schedule of schedules) {
    console.log(`- ${schedule.scheduleId}: ${schedule.cron} -> ${schedule.destination}`);
  }
} catch (error) {
  console.error('Failed to create QStash API monitoring schedules:');
  console.error(error?.message || error);
  process.exitCode = 1;
}
