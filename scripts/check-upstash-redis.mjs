import '../src/config/env.js';
import { pingRedis } from '../src/config/redis.js';

const redis = await pingRedis();

console.log(JSON.stringify({ redis }, null, 2));

if (!redis.connected) {
  process.exitCode = 1;
}
