// Internal implementation; agents use the installed `nucleus` command.
// Bulk disposition operator helper: start, follow or retry one bulk request.
// Exposed through `nucleus helper bulk-dispose`.

import { queueClient } from './queue-client.mjs';
const viaPaseo=process.argv.includes('--via-paseo');
process.argv=process.argv.filter(arg=>arg!=='--via-paseo');
import { readFileSync } from 'node:fs';

const usage = 'Usage: nucleus helper bulk-dispose start REQUEST.json | status OPERATION_ID | retry OPERATION_ID';
if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) { console.log(usage); process.exit(0); }
const [command, value] = process.argv.slice(2);
if (!['start', 'status', 'retry'].includes(command) || !value)
  throw new Error(usage);
const input = command === 'start' ? JSON.parse(readFileSync(value, 'utf8')) : { operationId: value };
const method = command === 'start' ? 'queue.bulk-disposition' : command === 'status' ? 'queue.bulk-disposition-detail' : 'queue.bulk-disposition-retry';
const client=await queueClient({viaPaseo});
try {
  await client.connect();
  console.log(JSON.stringify(await client.request(method, input), null, 2));
} finally { await client.close(); }
