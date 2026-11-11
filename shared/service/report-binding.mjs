import { resolve, sep } from "node:path";

/**
 * Whether a report-binding file lives under the current data home. The check is
 * the resolved path, not a special case for a data-home move.
 */
export function pathIsUnderDataHome(path, dataHome) {
  if (!path || !dataHome) return false;
  const resolved = resolve(path);
  const home = resolve(dataHome);
  const prefix = home.endsWith(sep) ? home : home + sep;
  return resolved === home || resolved.startsWith(prefix);
}

export function runIdMismatchRefusal({ toolName, boundRunId, namedRunId, kind, bindingUnderDataHome }) {
  const verb = kind === "report" ? "report" : kind === "ask" ? "ask" : "message";
  const past = kind === "report" ? "reported" : kind === "ask" ? "asked" : "sent";
  if (bindingUnderDataHome)
    return `This ${toolName} session is bound to run ${boundRunId}; the ${verb} named run ${namedRunId}, so nothing was ${past}. Resend the same ${verb} with runId ${boundRunId}, or omit runId.`;
  return `This ${toolName} session is bound to run ${boundRunId} through a ticket outside the current data home; the ${verb} named run ${namedRunId}, so nothing was ${past}. Do not resend through this callback. Nucleus will relaunch this role on a fresh thread that can report.`;
}
