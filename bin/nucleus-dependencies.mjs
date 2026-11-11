// Task dependency helper: set or replace a task's prerequisite task IDs.

import { queueClient } from './queue-client.mjs';
const viaPaseo=process.argv.includes('--via-paseo');
process.argv=process.argv.filter(arg=>arg!=='--via-paseo');

const [taskId, ...dependsOn] = process.argv.slice(2);
if (!taskId) throw new Error('Usage: node bin/nucleus-dependencies.mjs TASK_ID [PREREQUISITE_TASK_ID ...]');
if (new Set(dependsOn).size !== dependsOn.length) throw new Error('Duplicate prerequisite task IDs');

const client=await queueClient({viaPaseo});
try {
  await client.connect();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { task } = await client.request('queue.detail', { taskId });
    try {
      const updated = await client.request('queue.task', { taskId, version: task.version, action: 'set_dependencies', dependsOn });
      console.log(JSON.stringify({ taskId: updated.id, version: updated.version, phase: updated.phase, dependsOn: updated.dependsOn, reason: updated.reason }, null, 2));
      break;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('Task changed')) throw error;
    }
  }
} finally {
  await client.close();
}
