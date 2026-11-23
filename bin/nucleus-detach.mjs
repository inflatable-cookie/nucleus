// Internal implementation; agents use the installed `nucleus` command.
// Explicit presentation detach (nucleus#1313): record that a task's presentation
// has no planner thread, so every host renders its group standalone and a planner
// thread can be replaced or archived without taking its tasks' threads with it.
// It names no new planner and changes no question route: `nucleus helper reparent`
// moves ownership, and naming a new planner re-nests the group and clears this record.
import { resolveCliCaller } from './caller.mjs';
import { queueClient } from './queue-client.mjs';

const viaPaseo = process.argv.includes('--via-paseo');
process.argv = process.argv.filter(arg => arg !== '--via-paseo');

const usage = 'Usage: nucleus helper detach --task TASK_ID [--task TASK_ID ...] [--reason TEXT]';
const args = process.argv.slice(2);
if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); process.exit(0); }
const taskIds = [];
let reason = null;
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (!value || value.startsWith('--')) throw Error(usage);
  if (flag === '--task') taskIds.push(value);
  else if (flag === '--reason' && reason === null) reason = value;
  else throw Error(usage);
}
if (!taskIds.length) throw Error(usage);
const caller = (await resolveCliCaller({ viaPaseo })).caller;

const client = await queueClient({ viaPaseo });
try {
  await client.connect();
  const detached = [];
  for (const taskId of taskIds) {
    // The control is version-guarded; `next` is the one read that answers the
    // task's current version, so the helper never guesses one.
    const next = await client.request('queue.next', { taskId });
    const task = await client.request('queue.task', {
      action: 'detach', taskId, version: next.version, caller,
      ...(reason === null ? {} : { reason }),
    });
    detached.push({
      taskId, number: task.number ?? null, version: task.version,
      presentationDetached: task.presentationDetached, stop: task.resolution?.stop ?? null,
    });
  }
  console.log(JSON.stringify(detached.length === 1 ? detached[0] : detached, null, 2));
} finally { await client.close(); }
