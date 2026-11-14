// One versioned task write, applied with the one retry rule the CLI allows.
//
// A versioned write loses to any other writer: the task's version moves and the
// service refuses with "Task changed". The legacy helpers and the subscribe
// helper each carried their own copy of this loop and each decided retryability
// by matching words in the refusal text, so a reworded refusal silently stopped
// retrying (or started retrying something it should not).
//
// The rule here is typed. A write is repeated only when it is declared
// idempotent and the failure is one the transport says is uncertain: a typed
// code in UNCERTAIN_CODES, or no code at all (a lost socket looks like a moving
// service). A definitive answer — `refused`, `invalid_input`, `method_unknown`,
// `unauthenticated`, `protocol_version`, or a code this CLI does not know — is
// never repeated, because the request reached a served decision or an answer we
// cannot classify, and repeating it would be a second effect guessed at.
const UNCERTAIN_CODES = new Set(['timeout', 'unavailable', 'busy', 'draining', 'internal', 'oversize']);
const DEFAULT_ATTEMPTS = 3;

const retreat = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One line of a failure, with the transport's own `Queue service request failed (code): ` prefix kept. */
export function firstLine(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

/** Whether this failure may be repeated by an idempotent write. */
export function uncertainFailure(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return typeof code !== 'string' || UNCERTAIN_CODES.has(code);
}

/** Whether the retry loop ran out while the service kept answering uncertainly. */
export class VersionedWriteError extends Error {
  constructor(message, { reason, attempts, uncertain }) {
    super(message);
    this.name = 'VersionedWriteError';
    this.reason = reason;
    this.attempts = attempts;
    this.uncertain = uncertain;
  }
}

/**
 * Apply `method` with `input` as one versioned write of `taskId`.
 *
 * `idempotent` is the caller's contract, not an optimisation: a repeat of a
 * write that adds, removes or appends something is a second effect, so this
 * refuses to retry it at all rather than repeat it.
 */
export async function applyVersionedWrite(client, { taskId, method, input, idempotent, attempts = DEFAULT_ATTEMPTS, delay = retreat }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { task } = await client.request('queue.detail', { taskId });
      return await client.request(method, { ...input, taskId, version: task.version });
    } catch (error) {
      lastError = error;
      const retry = idempotent && attempt < attempts && uncertainFailure(error);
      if (!retry) break;
      // Retreat before re-reading the version: the writer that won the race
      // commits inside this window, so the retry sends the version it moved to.
      await delay(1000 * attempt);
    }
  }
  const reason = firstLine(lastError);
  const uncertain = uncertainFailure(lastError);
  throw new VersionedWriteError(idempotent && uncertain ? `${reason} (still changing after ${attempts} attempts; retry shortly)` : reason,
    { reason, attempts, uncertain });
}
