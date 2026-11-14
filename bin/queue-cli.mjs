// The Nucleus CLI front door: one method call, one payload, one answer.
//
// Reading the argv and the payload, loading the runtime from a source snapshot
// that stopped moving (./cli-bootstrap.mjs), stamping the authenticated caller
// and the pre-send refusals (./cli-stamping.mjs), and printing the answer or one
// line of refusal. Everything else lives in the owner named there; this file
// keeps no per-method branch of its own.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPayload } from './payload.mjs';
import { cliCallerSource, resolveCliCaller } from './caller.mjs';
import { identitySourceFor } from '../shared/caller.mjs';
import { loadCliRuntime, repoDirFrom } from './cli-bootstrap.mjs';
import { stampInput } from './cli-stamping.mjs';
import { credentialFor, readRunTicket, runTicketPath } from './run-ticket.mjs';
import { usageText } from './cli-usage.mjs';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const repoDir = repoDirFrom(dirname(fileURLToPath(import.meta.url)));

function snapshotBoundMessage(input) {
  const used = [];
  if (input?.repository) used.push(`repository=${JSON.stringify(input.repository)}`);
  if (input?.project) used.push(`project=${JSON.stringify(input.project)}`);
  if (input?.limit != null) used.push(`limit=${input.limit}`);
  if (input?.cursor) used.push('cursor');
  const filters = used.length ? used.join(', ') : 'none (pass repository, project, and/or a smaller limit)';
  return `queue.snapshot exceeded the ${MAX_FRAME_BYTES}-byte transport bound with filters: ${filters}. The service closed the socket instead of returning the payload. Retry with repository, project, and a smaller limit, then page with cursor. Terminal history is queue.outcome-search.`;
}

/** The service or the frame reader answered with its typed oversize code: its own message names the size. */
const typedOversize = error => Boolean(error) && typeof error === 'object' && error.code === 'oversize';

/**
 * A service that answers the refusal keeps its own message: it names the method,
 * the size and the bound. Only a snapshot that outgrew the bound before any
 * answer (the client's own socket close) gets this CLI's filter guidance, and no
 * other failure text is interpreted anywhere in this CLI.
 */
function isSnapshotOversize(error) {
  if (typedOversize(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Service socket closed/i.test(message);
}

/** `nucleus ui`: hand the link to the desktop's default browser; a missing opener only means the printed link is used. */
function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.error(`Could not open a browser; open the printed link yourself.`));
  child.unref();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg === '--help' || arg === '-h')) {
    console.log(usageText);
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
  const input = uiCommand ? { action: rest.includes('--revoke') ? 'revoke' : 'issue' } : readPayload(file);
  if (rest.includes('--wait')) {
    if (method !== 'project.qa.run') throw new Error('--wait is supported by project.qa.run; lead.submit always waits');
    input.wait = true;
  }

  // Self-force is authenticated by this run's ticket, never a typed caller. A
  // participant ticket has a caller to resolve and takes the ordinary route.
  if ((method === 'task' || method === 'queue.task') && input?.force && runTicketPath()) {
    const ticket = readRunTicket();
    if (ticket && !ticket.participantId) {
      const credential = credentialFor(ticket, 'self-force');
      const { callbackRequest } = await import('../shared/service/callback-client.mjs');
      const result = await callbackRequest(credential, '/task-control', {
        callerTaskId: ticket.taskId,
        callerRunId: ticket.runId, input,
      }, { timeoutMs: 45000, timeoutMessage: 'Self-force timed out; read the operation before retrying' });
      console.log(JSON.stringify(result));
      process.exit(0);
    }
  }

  let callerIdentity;
  const callingThread = async () => (await (callerIdentity ??= resolveCliCaller({ viaPaseo }))).caller;
  /** The calling thread's own proven host, bound to that same identity and never to another. */
  const callingThreadSource = async agent => identitySourceFor(await (callerIdentity ??= resolveCliCaller({ viaPaseo })), agent);
  const stamped = await stampInput({
    method, input,
    context: {
      callingThread, callingThreadSource,
      callerSource: () => cliCallerSource(),
      readTicket: () => readRunTicket(),
      credentialFor,
      newRequestId: () => randomUUID(),
      onQaRequestId(requestId) {
        console.error(`QA request ID: ${requestId}; reconcile with project.qa.request-status, never repeat with a new ID after unknown delivery.`);
      },
      async answerThroughTicket(ticket, payload) {
        const { callbackRequest } = await import('../shared/service/callback-client.mjs');
        const body = { ...payload, eventId: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
        return await callbackRequest(credentialFor(ticket, 'question.answer'), '/answer', body, {
          timeoutMs: 45000, timeoutMessage: 'Callback timed out; retry the same JSON',
        });
      },
    },
  });
  const payloadInput = stamped.input;
  if (stamped.early !== undefined) {
    console.log(JSON.stringify(stamped.early));
    process.exit(0);
  }

  // Most methods are `queue.*`; a few (such as `lanes`) are registered without a prefix.
  // Try the prefixed name first and fall back to the name as given if it is not a method.
  const unknown = error => error instanceof Error && /^Unknown Queue service method/.test(error.message);
  const snapshotMethod = method === 'snapshot' || method === 'queue.snapshot';
  let client;
  try {
    if (method === 'adopt' || method === 'queue.adopt') throw new Error('Worker adoption is retired; use review entry to bring an external PR onto the board');
    const { RPC_CATALOGUE, parseContractValue, client: runtimeClient } = await loadCliRuntime({ repoDir, viaPaseo });
    client = runtimeClient;
    const names = method.includes('.') ? [method] : [`queue.${method}`, method];
    const entry = names.map(name => RPC_CATALOGUE.find(item => item.name === name)).find(Boolean);
    const payload = entry ? parseContractValue(entry.contract.input, payloadInput) : payloadInput;
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
    if (uiCommand && payloadInput.action === 'issue') {
      console.log(result.url);
      console.error(`Board link valid until ${result.expiresAt}; refused after that, or once \`nucleus ui --revoke\` runs.`);
      if (!rest.includes('--no-open')) openInBrowser(result.url);
    } else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (snapshotMethod && isSnapshotOversize(error)) console.error(typedOversize(error) ? message : snapshotBoundMessage(payloadInput));
    else if ((method === 'lead.submit' || method === 'lead.promote-task' || method === 'papercut.promote-task') && /timed out|timeout/i.test(message)) {
      const target = method === 'lead.submit' ? 'lead.list by repository and title, then lead.get promotedTaskId' : method === 'lead.promote-task' ? 'lead.get promotedTaskId' : 'papercut.get taskId';
      console.error(`outcome unknown — check ${target} (or operation <id> with queue.operation-status); do not repeat blindly. ${message}`);
    }
    else console.error(message);
    process.exitCode = 1;
  } finally {
    await client?.close();
  }
}

/**
 * Every refusal this CLI makes is one line naming what to do, whether it comes
 * from the pre-send stamping, the runtime load or the service answer. The exit
 * code stays 1 and the message stays the same; only the stack trace, which
 * named no action, is gone.
 */
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
