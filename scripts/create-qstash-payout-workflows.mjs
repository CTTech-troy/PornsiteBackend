import '../src/config/env.js';
import { createPayoutWorkflowSchedules } from '../src/config/qstash.js';

try {
  const schedules = await createPayoutWorkflowSchedules();
  console.log('Created or updated QStash payout workflow schedules:');
  for (const schedule of schedules) {
    console.log(`- ${schedule.scheduleId}: ${schedule.cron} -> ${schedule.destination}`);
  }
} catch (error) {
  console.error('Failed to create QStash payout workflow schedules:');
  console.error(error?.message || error);
  process.exitCode = 1;
}
