// Completion-subscription helper: subscribe or unsubscribe the calling thread.
//
// The calling thread comes from the shared caller resolver, and the write is one
// versioned task write through the CLI's single retry owner
// (./versioned-write.mjs): subscribing is idempotent, so a moved version is
// retried with a fresh read, while a definitive refusal is reported as it is.
import { resolveCliCaller } from './caller.mjs';
import { queueClient } from './queue-client.mjs';
import { applyVersionedWrite, VersionedWriteError } from './versioned-write.mjs';

const viaPaseo = process.argv.includes('--via-paseo');
process.argv = process.argv.filter(arg => arg !== '--via-paseo');

const [taskId, action] = process.argv.slice(2);
if (!taskId || !['subscribe', 'unsubscribe'].includes(action)) throw Error('Usage: node bin/nucleus-subscribe.mjs TASK_ID subscribe|unsubscribe');
const agentId = (await resolveCliCaller({ viaPaseo })).caller;
const client = await queueClient({ viaPaseo });
try {
  await client.connect();
  try {
    const task = await applyVersionedWrite(client, {
      taskId, method: 'queue.completion-subscription', input: { agentId, action }, idempotent: true,
    });
    console.log(JSON.stringify({ taskId: task.id, agentId, action, version: task.version }, null, 2));
  } catch (error) {
    if (!(error instanceof VersionedWriteError)) throw error;
    console.error(`Completion ${action} for task ${taskId} failed: ${error.message}`);
    process.exitCode = 1;
  }
} finally {
  await client.close();
}
