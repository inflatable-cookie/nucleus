import { compiledIdentity } from '../shared/runtime.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPayload } from './payload.mjs';
import { queueClient } from './queue-client.mjs';
import { cliCallerSource, resolveCliCaller } from './caller.mjs';
import { identitySourceFor } from '../shared/caller.mjs';
import { bootstrapEntries, bootstrapSources } from './bootstrap-sources.mjs';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const SOURCE_STABILITY_INTERVAL_MS = 250;
const SOURCE_STABILITY_TIMEOUT_MS = 10_000;

const cliDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(cliDir, '..');

function fingerprintSources(sources) {
  const hash = createHash('sha256');
  for (const [path, bytes] of sources) {
    hash.update(path);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function bootstrapSourceFingerprint() {
  return fingerprintSources(await bootstrapSources(repoDir));
}

async function waitForStableBootstrapSources() {
  const deadline = Date.now() + SOURCE_STABILITY_TIMEOUT_MS;
  let previous;
  let matchingSamples = 0;
  while (Date.now() < deadline) {
    try {
      const fingerprint = await bootstrapSourceFingerprint();
      if (fingerprint === previous) matchingSamples++;
      else matchingSamples = 0;
      if (matchingSamples >= 2) return fingerprint;
      previous = fingerprint;
    } catch {
      previous = undefined;
      matchingSamples = 0;
    }
    await new Promise(resolve => setTimeout(resolve, SOURCE_STABILITY_INTERVAL_MS));
  }
  throw new Error(`Nucleus TypeScript sources did not settle within ${SOURCE_STABILITY_TIMEOUT_MS / 1000} seconds`);
}

async function createBootstrapSnapshot() {
  const sources = await bootstrapSources(repoDir);
  const before = fingerprintSources(sources);
  const snapshotParent = join(repoDir, '.effigy', 'cache');
  await mkdir(snapshotParent, { recursive: true });
  const snapshotRoot = await mkdtemp(join(snapshotParent, 'queue-cli-bootstrap-'));
  try {
    for (const [path, bytes] of sources) {
      const destination = join(snapshotRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o600 });
    }
    const copied = fingerprintSources(await bootstrapSources(snapshotRoot));
    const after = await bootstrapSourceFingerprint();
    if (before !== copied || copied !== after) {
      throw new Error('Nucleus sources changed while creating the CLI bootstrap snapshot');
    }
    return { root: snapshotRoot, fingerprint: copied };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

async function importCliRuntime(snapshotRoot) {
  if (compiledIdentity) {
    const { RPC_CATALOGUE } = await import("../shared/rpc-catalogue.ts");
    const { parseContractValue } = await import("../shared/schema-refusal.ts");
    return { RPC_CATALOGUE, parseContractValue, client: await queueClient({ viaPaseo }) };
  }
  if (!compiledIdentity) await import('tsx');
  const base = snapshotRoot || repoDir;
  const { RPC_CATALOGUE } = await import(pathToFileURL(join(base, bootstrapEntries[0])).href);
  const { parseContractValue } = await import(pathToFileURL(join(base, bootstrapEntries[1])).href);
  const client = snapshotRoot && !viaPaseo
    ? (await import(pathToFileURL(join(base, bootstrapEntries[2])).href)).localQueueClient()
    : await queueClient({ viaPaseo });
  return { RPC_CATALOGUE, parseContractValue, client };
}

async function loadFromBootstrapSnapshot(expectedFingerprint) {
  const snapshot = await createBootstrapSnapshot();
  try {
    if (expectedFingerprint && snapshot.fingerprint !== expectedFingerprint) {
      throw new Error('Nucleus sources changed after the CLI bootstrap stability proof');
    }
    return await importCliRuntime(snapshot.root);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
}

async function loadCliRuntime() {
  if (compiledIdentity) return importCliRuntime();
  let firstError;
  try {
    const before = await bootstrapSourceFingerprint();
    const runtime = await importCliRuntime();
    const after = await bootstrapSourceFingerprint();
    if (before === after) return runtime;
    firstError = new Error('Nucleus sources changed during CLI bootstrap');
  } catch (error) {
    firstError = error;
  }

  const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
  let stableFingerprint;
  try {
    stableFingerprint = await waitForStableBootstrapSources();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Nucleus CLI bootstrap failed before any service request (${firstMessage}); ${detail}; no service request was sent.`);
  }

  try {
    return await loadFromBootstrapSnapshot(stableFingerprint);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Nucleus CLI bootstrap still failed after source stabilization; no service request was sent. ${detail}`);
  }
}

function snapshotBoundMessage(input) {
  const used = [];
  if (input?.repository) used.push(`repository=${JSON.stringify(input.repository)}`);
  if (input?.project) used.push(`project=${JSON.stringify(input.project)}`);
  if (input?.limit != null) used.push(`limit=${input.limit}`);
  if (input?.cursor) used.push('cursor');
  const filters = used.length ? used.join(', ') : 'none (pass repository, project, and/or a smaller limit)';
  return `queue.snapshot exceeded the ${MAX_FRAME_BYTES}-byte transport bound with filters: ${filters}. The service closed the socket instead of returning the payload. Retry with repository, project, and a smaller limit, then page with cursor. Terminal history is queue.outcome-search.`;
}

function isSnapshotOversize(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Service socket closed|exceeds the \d+ byte protocol bound|Frame of \d+ bytes exceeds/i.test(message);
}

/** `nucleus ui`: hand the link to the desktop's default browser; a missing opener only means the printed link is used. */
function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(`Could not open a browser; open the printed link yourself.`));
  child.unref();
}

const args = process.argv.slice(2);
if (args.some(arg => arg === '--help' || arg === '-h')) {
  console.log(`Usage: node bin/queue-cli.mjs [--via-paseo] <method> [- | payload.json] [--wait]

Calls one Nucleus service method with a JSON payload. Pass - to read it from stdin
(the default route: no shared temporary files), a path to read a file, or nothing
for {}. A heredoc avoids shell quoting:
  node bin/queue-cli.mjs plan.get - <<'JSON'
  {"repository":"owner/name"}
  JSON
Methods without a dot are tried as queue.<method> first, for example:
  snapshot, detail, telemetry, outcome, outcome-search, task, next, operation-start,
  operation-status, capacity-state, lanes, lane.upsert, lane.status, projects, project.upsert,
  project.get, project.settings, project.park, project.unpark, project.remove, project.removal-blockers, project.qa.run, project.qa.cancel, project.qa.dismiss, project.qa.retry-teardown, project.qa.get, project.qa.list, repositories, repository.set, repository.get, repository.rekey-preview, repository.rekey, repository.rekey-receipt, papercut.add, papercut.list, papercut.get, papercut.edit, papercut.promote, papercut.promote-task,
  papercut.close, papercut.set-lanes, lead.add, lead.edit, lead.get, lead.version,
  lead.list, lead.set-lanes, lead.set-tags, lead.drop, lead.reopen, lead.promote, lead.check, lead.approve, lead.promote-task, lead.submit, lead.import,
  decision.add, decision.get, decision.list, decision.answer, decision.withdraw, decision.link, decision.supersede, queue.routing-grant, lane.document.get,
  lane.document.edit, plan.get, plans, plan.set, backup.now, backup.list, usage.state
snapshot accepts optional repository, project, limit (default 100, max 250) and
cursor; page while hasMore is true. An oversized snapshot is refused with those
filters named instead of a closed socket.
project.qa.run --wait returns the settled run, exitCode, failureIndexes and failuresLogPath.
lead.submit submits an authorized brief through check, approval and promotion in one call.
next (task.next) takes a taskId or a reference such as owner/name#12 and reads
what steers the task: phase, active run, PR head, the current stop or wait,
holds, and every owner verb with prefilled arguments and its refusal. Run next
first, then call task with the listed args plus the reason or instruction it
asks you to fill.
Task IDs also accept references such as nucleus#1070. Task owner verbs may omit
version, optionally fence an observed phase, and return the changed field names.
Queued next offers set_dependencies; its dependsOn list accepts references too.
capacity is not a CLI route: only the operator changes dispatch limits, in
Settings, and a CLI call refuses without changing anything. capacity-state reads
the values in force and the recorded changes; do not retry a refused write.
ui prints a link to the local board (127.0.0.1 only; the token rides in the link's
fragment and expires after 8 hours). ui opens it in the browser (use --no-open to print only), and
ui --revoke revokes every outstanding link. A link is the operator's board access,
so do not paste it into a shared log or prompt.
--via-paseo routes through the Paseo bridge (needed for bridge-only methods such as service-state).
See README.md "CLI methods" and the nucleus skill for payload shapes. Only the
"nucleus" skill is installed; the retired "northstar-queue" name survives in
submitted handoffs, which may still carry it in queue_dispatch.`);
  process.exit(0);
}
const viaPaseo = args.includes('--via-paseo');
const [requestedMethod = 'snapshot', ...rest] = args.filter(arg => arg !== '--via-paseo');
// `ui` mints a board link (or revokes every link with --revoke) on the owner socket; its
// flags are not a payload file. See the service-boundary contract, "Local web board".
const uiCommand = requestedMethod === 'ui';
const file = uiCommand ? undefined : rest.find(arg => arg !== '--wait');
// Spec 050: the CLI verb name for the task.next read RPC.
const method = uiCommand ? 'service.ui-link' : requestedMethod === 'next' ? 'task.next' : requestedMethod;
let callerIdentity;
const callingThread = async () => (await (callerIdentity ??= resolveCliCaller({ viaPaseo }))).caller;
/** The calling thread's own proven host, bound to that same identity and never to another. */
const callingThreadSource = async agent => identitySourceFor(await (callerIdentity ??= resolveCliCaller({ viaPaseo })), agent);
const input = uiCommand ? { action: rest.includes('--revoke') ? 'revoke' : 'issue' } : readPayload(file);
if (method === 'task.next' && input && typeof input === 'object') delete input.caller;
if (rest.includes('--wait')) {
  if (method !== 'project.qa.run') throw new Error('--wait is supported by project.qa.run; lead.submit always waits');
  input.wait = true;
}
if (method === 'project.qa.run' && input && typeof input === 'object') {
  input.requestId ??= randomUUID();
  input.submitterAgentId = await callingThread();
  console.error(`QA request ID: ${input.requestId}; reconcile with project.qa.request-status, never repeat with a new ID after unknown delivery.`);
}
if (method === 'lead.approve') {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.relayed === false || input.approver === 'operator (board)')
    throw new Error('CLI lead approval must identify the agent and be relayed');
  input.relayed = true;
  input.approver = await callingThread();
}
if (method === 'decision.answer') {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.relayed === false || input.answeredBy === 'operator (board)' || input.answeredBy === 'operator')
    throw new Error('CLI decision.answer must identify the relaying agent and be relayed');
  input.relayed = true;
  if (!input.note?.trim()) throw new Error('CLI decision.answer requires a note quoting the operator authorization');
  input.answeredBy = await callingThread();
}
if ((method === 'queue.routing-grant' || method === 'routing-grant') && input && typeof input === 'object' && !Array.isArray(input)) {
  if (input.action === 'revoke' || input.caller === 'operator (board)' || input.caller === 'operator')
    throw new Error('CLI cannot revoke a routing grant or claim the operator board; revoke from the board');
  input.caller = await callingThread();
}
if (method === 'lead.submit' || method === 'lead.promote-task' || method === 'papercut.promote-task') {
  if (input?.board) throw new Error('CLI promotion must identify the agent and cannot claim board approval');
  if (!input?.note?.trim()) throw new Error('CLI task promotion requires an agent and operator authorization note');
  input.agent = await callingThread();
  // The promoting thread's proven host travels with the identity it names, so a
  // registered host that has no part in this promotion cannot make its origin
  // ambiguous.
  const identitySource = await callingThreadSource(input.agent);
  if (identitySource) input.identitySource = identitySource;
}
if (method === 'task.register' && input && typeof input === 'object' && !Array.isArray(input)) {
  // The resolver overwrites a typed caller; the service binds this thread's worktree.
  input.caller = await callingThread();
}
if (method === 'agent.register' && input && typeof input === 'object' && !Array.isArray(input)) {
  // Task 1110: a thread registers itself from its Nucleus ticket; another thread is named from the board.
  if (input.agentId !== undefined) throw new Error('CLI agent.register registers the calling thread; register another thread from the board');
  input.caller = await callingThread();
}
if (method === 'agent.unregister' && input && typeof input === 'object' && !Array.isArray(input)) {
  input.caller = await callingThread();
}
// Self-force is authenticated by this run's ticket, never a typed caller.
if (['task', 'queue.task'].includes(method) && input?.force && (process.env.NUCLEUS_CONTINUATION_TICKET || process.env.NUCLEUS_TICKET)) {
  const ticketPath = process.env.NUCLEUS_CONTINUATION_TICKET || process.env.NUCLEUS_TICKET;
  const ticket = JSON.parse(await readFile(ticketPath, 'utf8'));
  if (process.env.NUCLEUS_CONTINUATION_RUN_ID && ticket.runId !== process.env.NUCLEUS_CONTINUATION_RUN_ID)
    throw new Error('Continuation ticket does not match the current run; use the ticket path supplied in the continuation prompt');
  if (!ticket.participantId) {
    if (typeof ticket.token !== 'string' || typeof ticket.socketPath !== 'string' ||
        typeof ticket.taskId !== 'string' || typeof ticket.runId !== 'string')
      throw new Error('The Nucleus run ticket is incomplete; self-force is unavailable');
    const { callbackRequest } = await import('../shared/service/callback-client.mjs');
    const result = await callbackRequest({socketPath: ticket.socketPath,
      token: ticket.token}, '/task-control', {
      callerTaskId: ticket.taskId,
      callerRunId: ticket.runId, input,
    }, {timeoutMs:45000, timeoutMessage:'Self-force timed out; read the operation before retrying'});
    console.log(JSON.stringify(result));
    process.exit(0);
  }
}
if ((method === 'task' || method === 'queue.task') && ['set_routing', 'exclude_worker'].includes(input?.action) && !(input.action === 'set_routing' && input.critical !== undefined && !['scope','complexity','preferredProfileId','requirePreferred','thinkingOptionId','profileRequests'].some(key => input[key] !== undefined))) {
  if (!input.note?.trim()) throw new Error(`CLI ${input.action} requires a note naming operator authorization`);
  input.relayed = true;
}
if ((method === 'task' || method === 'queue.task') && input && typeof input === 'object' && !Array.isArray(input)) {
  // Spec 050: the calling thread rides along on every task control so the
  // owner_control audit event can name it.
  input.caller = await callingThread();
}
if ((method === 'task' || method === 'queue.task') && input?.action === 'accept_receipt') {
  if (!input.relayed || !input.note?.trim())
    throw new Error('CLI receipt acceptance requires the relaying thread and an operator authorization note');
  input.caller = await callingThread();
}
if ((method === 'task' || method === 'queue.task') && input?.action === 'complete') {
  // Spec 050: a completion is recorded against the calling thread, like every owner verb.
  input.caller = await callingThread();
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('CLI complete requires a reason');
}
if ((method === 'task' || method === 'queue.task') && (input?.action === 'hold' || input?.action === 'keep_hold')) {
  // Spec 040: a hold has a reason and an owner, for every caller. The owner is the calling thread.
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error(`CLI ${input.action} requires a reason`);
  input.agentId = await callingThread();
}
if (method === 'repository.rekey') {
  // Spec 056: a re-key is an operator act. The CLI records who asked, who
  // relayed it and why, and refuses to invent an idempotency key: a lost reply
  // must reconcile the same step, never start a second one.
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CLI repository.rekey takes {source, target, expectedSourceRevision, reason, idempotencyKey}');
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('CLI repository.rekey requires a reason quoting the operator authorization');
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('CLI repository.rekey requires the caller\'s idempotencyKey');
  input.author ??= 'operator';
  input.relayedBy = await callingThread();
}
if (method === 'question.answer') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CLI question.answer takes {questionId, answer or choice, reason}');
  const identity = cliCallerSource();
  if (identity.source === 'ticket') {
    const ticket = JSON.parse(await readFile(identity.path, 'utf8'));
    if (process.env.NUCLEUS_CONTINUATION_RUN_ID && ticket.runId !== process.env.NUCLEUS_CONTINUATION_RUN_ID)
      throw new Error(`Continuation ticket is for run ${ticket.runId ?? 'unknown'}, not current run ${process.env.NUCLEUS_CONTINUATION_RUN_ID}; use the ticket path supplied in the continuation prompt`);
    if (ticket.participantId) {
      const resolved = await resolveCliCaller({ viaPaseo, source: identity });
      input.caller = resolved.caller;
      const identitySource = identitySourceFor(resolved, input.caller);
      if (identitySource) input.identitySource = identitySource;
    } else {
      if (typeof ticket.token !== 'string' || typeof ticket.socketPath !== 'string' ||
          typeof ticket.taskId !== 'string' || typeof ticket.runId !== 'string')
        throw new Error('The Nucleus run ticket is incomplete; question.answer is unavailable');
      if (typeof input.questionId !== 'string' || !input.questionId.trim())
        throw new Error('CLI question.answer with a run ticket takes {questionId, answer or choice, reason}');
      const { callbackRequest } = await import('../shared/service/callback-client.mjs');
      const payload = {
        taskId: ticket.taskId, runId: ticket.runId, questionId: input.questionId,
        answer: input.answer, choice: input.choice, reason: input.reason,
        decision: input.decision, overtakes: input.overtakes,
      };
      for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
      payload.eventId = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const result = await callbackRequest({ socketPath: ticket.socketPath, token: ticket.token }, '/answer', payload, {
        timeoutMs: 45000, timeoutMessage: 'Callback timed out; retry the same JSON',
      });
      console.log(JSON.stringify(result));
      process.exit(0);
    }
  } else {
    input.caller = await callingThread();
    // The answering thread's proven host travels with the identity it names, so a
    // host with no part in this answer cannot make it ambiguous.
    const identitySource = await callingThreadSource(input.caller);
    if (identitySource) input.identitySource = identitySource;
  }
}
if (method === 'project.set-planner') {
  // Spec 058 (task 540): the planner names itself, or the operator names one; the calling thread is recorded as the setter.
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CLI project.set-planner takes {key, agentId}');
  input.setBy = await callingThread();
}
// Most methods are `queue.*`; a few (such as `lanes`) are registered without a prefix.
// Try the prefixed name first and fall back to the name as given if it is not a method.
const unknown = error => error instanceof Error && /^Unknown Queue service method/.test(error.message);
const snapshotMethod = method === 'snapshot' || method === 'queue.snapshot';
let client;
try {
  if (method === 'adopt' || method === 'queue.adopt') throw new Error('Worker adoption is retired; use review entry to bring an external PR onto the board');
  const { RPC_CATALOGUE, parseContractValue, client: runtimeClient } = await loadCliRuntime();
  client = runtimeClient;
  const names = method.includes('.') ? [method] : [`queue.${method}`, method];
  const entry = names.map(name => RPC_CATALOGUE.find(item => item.name === name)).find(Boolean);
  const payload = entry ? parseContractValue(entry.contract.input, input) : input;
  // The Settings-only capacity rule (service-boundary contract): queue.capacity is
  // not a CLI route. It refuses here, before any service request, and the service
  // refuses the same shape at its dispatch point, so a caller that skips this still
  // changes nothing.
  if (method === 'capacity' || method === 'queue.capacity') {
    const { capacityWriteRefusalMessage } = await import('../shared/capacity-authority.ts');
    throw new Error(capacityWriteRefusalMessage());
  }
  await client.connect();
  const call = name => client.request(name, payload);
  let result;
  if (method.includes('.')) result = await call(method);
  else { try { result = await call(`queue.${method}`); } catch (error) { if (!unknown(error)) throw error; result = await call(method); } }
  if (uiCommand && input.action === 'issue') {
    console.log(result.url);
    console.error(`Board link valid until ${result.expiresAt}; refused after that, or once \`nucleus ui --revoke\` runs.`);
    if (!rest.includes('--no-open')) openInBrowser(result.url);
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (snapshotMethod && isSnapshotOversize(error)) console.error(snapshotBoundMessage(input));
  else if ((method === 'lead.submit' || method === 'lead.promote-task' || method === 'papercut.promote-task') && /timed out|timeout/i.test(message)) {
    const target = method === 'lead.submit' ? 'lead.list by repository and title, then lead.get promotedTaskId' : method === 'lead.promote-task' ? 'lead.get promotedTaskId' : 'papercut.get taskId';
    console.error(`outcome unknown — check ${target} (or operation <id> with queue.operation-status); do not repeat blindly. ${message}`);
  }
  else console.error(message);
  process.exitCode = 1;
} finally {
  await client?.close();
}
