// Internal implementation; agents use the installed `nucleus` command.
// Spec 067 explicit commands lead with their outcome (papercut ee6e634c, Spec 068
// batch 5a): a command that needs warnings accepted, or was sent at a stale
// version, applied nothing, and must not look like it succeeded.

/** The explicit resolution commands the CLI sends as `task` with this action. */
export const EXPLICIT_COMMANDS = ['run.start', 'run.release', 'record.clear', 'phase.set', 'message.send', 'turn.take', 'turn.release', 'merge.now', 'closeout.now'];

/** Exit code for an explicit command that applied nothing (warnings or stale). Refusals keep exit code 1. */
export const NOT_APPLIED_EXIT_CODE = 2;

/**
 * Warnings only the live responsible planner or the operator board may accept; a
 * coordinator that names one is refused. Mirrors `PLANNER_ONLY_WARNINGS` in
 * shared/schema/resolution-warnings.ts (a test holds the two equal).
 */
export const PLANNER_ONLY_WARNING_IDS = ['hold_owner', 'route_policy', 'two_writers', 'creation_in_flight', 'budget'];
/** Warnings only the operator board may accept (`OPERATOR_ONLY_WARNINGS`). */
export const OPERATOR_ONLY_WARNING_IDS = ['unverified_merge'];

/**
 * The one-line summary printed before the JSON body, and the exit code. `applied`
 * exits 0; `warnings: <ids>` and `stale` applied nothing and exit 2. The warnings
 * line names the exact `accept` list to resend, then which of those IDs only the
 * planner or the operator board may accept, so a coordinator does not resend a list
 * it would be refused. Null for an answer without an explicit resolution (a refusal
 * is already one line on stderr).
 */
export function explicitOutcome(result) {
  const resolution = result && typeof result === 'object' ? result.explicitResolution : undefined;
  if (!resolution || typeof resolution !== 'object') return null;
  if (resolution.status === 'applied') {
    const run = resolution.runId ? ` (run ${resolution.runId})` : '';
    const delivery = resolution.delivery ? `; message delivery ${resolution.delivery}` : '';
    return { line: `applied${run}${delivery}`, exitCode: 0 };
  }
  if (resolution.status === 'warnings') {
    const ids = [...new Set((resolution.warnings ?? []).map(warning => warning.id))];
    const plannerOnly = ids.filter(id => PLANNER_ONLY_WARNING_IDS.includes(id));
    const operatorOnly = ids.filter(id => OPERATOR_ONLY_WARNING_IDS.includes(id));
    const restricted = [
      ...(plannerOnly.length ? [`only the live responsible planner or the operator board may accept ${plannerOnly.join(', ')}`] : []),
      ...(operatorOnly.length ? [`only the operator board may accept ${operatorOnly.join(', ')}`] : []),
    ];
    return {
      line: `warnings: ${ids.join(', ')} (not applied; resend with "accept": ${JSON.stringify(ids)} to apply${restricted.map(part => `; ${part}`).join('')})`,
      exitCode: NOT_APPLIED_EXIT_CODE,
    };
  }
  if (resolution.status === 'stale') {
    const version = typeof result.version === 'number' ? ` at version ${result.version}` : '';
    return { line: `stale: not applied; the task is now${version}, so read next and resend with that version`, exitCode: NOT_APPLIED_EXIT_CODE };
  }
  return { line: `${String(resolution.status)}: not applied`, exitCode: NOT_APPLIED_EXIT_CODE };
}
