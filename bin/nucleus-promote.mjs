// Task priority helper: promote one task through the same service contract as the board.

import { queueClient } from './queue-client.mjs';
const viaPaseo=process.argv.includes('--via-paseo');
process.argv=process.argv.filter(arg=>arg!=='--via-paseo');

const taskId = process.argv[2];
if (!taskId) throw new Error('Usage: node bin/nucleus-promote.mjs TASK_ID');
const client=await queueClient({viaPaseo});
try {
  await client.connect();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { task } = await client.request('queue.detail', { taskId });
    try {
      const updated = await client.request('queue.task', { taskId, version: task.version, action: 'promote' });
      console.log(JSON.stringify({ taskId: updated.id, version: updated.version, phase: updated.phase, queuePriority: updated.queuePriority }, null, 2));
      break;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('Task changed')) throw error;
    }
  }
} finally {
  await client.close();
}
