import '../src/config/env.js';
import { createAiModerationWorkflowSchedules } from '../src/config/qstash.js';

try {
  const schedules = await createAiModerationWorkflowSchedules();
  console.log(JSON.stringify({ ok: true, schedules }, null, 2));
} catch (error) {
  console.error('[qstash:ai-moderation] schedule creation failed:', error?.message || error);
  process.exitCode = 1;
}
