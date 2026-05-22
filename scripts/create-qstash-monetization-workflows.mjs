import '../src/config/env.js';
import { createMonetizationWorkflowSchedules } from '../src/config/qstash.js';

try {
  const schedules = await createMonetizationWorkflowSchedules();
  console.log('Created or updated QStash monetization workflow schedules:');
  for (const schedule of schedules) {
    console.log(`- ${schedule.scheduleId}: ${schedule.cron} -> ${schedule.destination}`);
  }
} catch (error) {
  console.error('Failed to create QStash monetization workflow schedules:');
  console.error(error?.message || error);
  process.exitCode = 1;
}
