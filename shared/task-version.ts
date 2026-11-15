/**
 * A task or run moved while an owner control was being verified. The refusal
 * carries the versions it compared, so a caller adds the re-read hint from the
 * typed fact instead of matching the refusal's words, and never resends the
 * stale payload.
 */
export class TaskChangedRefusal extends Error {
  constructor(message: string, readonly expected: number, readonly current: number) {
    super(message);
  }
}

/** The one stale-version refusal text an owner reads, with the version to re-read. */
export function taskChangedHint(message: string, current: number): string {
  return `${message} (the task is now version ${current}; read next again and reassess before retrying)`;
}
