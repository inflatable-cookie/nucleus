// Task disposition helper: cancel or supersede one task with a durable reason.

import { queueClient } from './queue-client.mjs';
const viaPaseo=process.argv.includes('--via-paseo');
process.argv=process.argv.filter(arg=>arg!=='--via-paseo');

// Usage: node bin/nucleus-dispose.mjs TASK_ID cancel --reason "..." [--work preserve|archive_if_empty]
//        node bin/nucleus-dispose.mjs TASK_ID supersede --reason "..." --replacement REPLACEMENT_TASK_ID [--work preserve|archive_if_empty|retained_by_replacement]
// One versioned operator action through the same service contract as the
// native RPC/UI and MCP tools. The disposition fence persists before any
// stop or archive request; ordinary recovery and relaunch honor it.
const [taskId, action, ...rest] = process.argv.slice(2);
if (!taskId || !['cancel', 'supersede'].includes(action)) {
  throw new Error('Usage: node bin/nucleus-dispose.mjs TASK_ID cancel|supersede --reason "..." [--replacement ID] [--work preserve|archive_if_empty|retained_by_replacement]');
}
const args = {};
for (let index = 0; index < rest.length; index++) {
  const flag = rest[index];
  if (flag === '--reason') args.reason = rest[++index];
  else if (flag === '--replacement') args.replacementTaskId = rest[++index];
  else if (flag === '--work') args.workDisposition = rest[++index];
  else throw new Error(`Unknown flag: ${flag}`);
}
if (!args.reason) throw new Error('Disposition requires --reason "..."');
if (action === 'supersede' && !args.replacementTaskId) throw new Error('Supersession requires --replacement REPLACEMENT_TASK_ID');
if (action !== 'supersede' && args.replacementTaskId) throw new Error('A replacement task is only valid for supersession');

const client=await queueClient({viaPaseo});
try {
  await client.connect();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { task } = await client.request('queue.detail', { taskId });
    try {
      const updated = await client.request('queue.task', {
        taskId, version: task.version, action,
        reason: args.reason,
        ...(args.replacementTaskId ? { replacementTaskId: args.replacementTaskId } : {}),
        ...(args.workDisposition ? { workDisposition: args.workDisposition } : {}),
      });
      if ('accepted' in updated || 'backpressured' in updated) {
        console.log(JSON.stringify(updated, null, 2));
        if ('backpressured' in updated) process.exitCode = 1;
        break;
      }
      console.log(JSON.stringify({ taskId: updated.id, version: updated.version, phase: updated.phase, disposition: updated.disposition, reason: updated.reason }, null, 2));
      break;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('Task changed')) throw error;
    }
  }
} finally {
  await client.close();
}
