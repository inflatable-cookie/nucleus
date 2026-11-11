/**
 * Host login-session faults from `gh` (macOS OSStatus -26276). These are
 * environment failures, never task faults: the Queue service outlived its
 * login session and lost trust-store access.
 */
export const LOGIN_SESSION_FAULT_TOKEN = "OSStatus -26276";

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & { stderr?: unknown; stdout?: unknown };
    return `${error.message}\n${String(extra.stderr ?? "")}\n${String(extra.stdout ?? "")}`;
  }
  if (error && typeof error === "object") {
    const extra = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
    return `${String(extra.message ?? "")}\n${String(extra.stderr ?? "")}\n${String(extra.stdout ?? "")}`;
  }
  return String(error);
}

export function isLoginSessionFault(error: unknown): boolean {
  return errorText(error).includes(LOGIN_SESSION_FAULT_TOKEN);
}

export class LoginSessionFaultError extends Error {
  constructor(readonly original: unknown) {
    super(`Login session environment fault (${LOGIN_SESSION_FAULT_TOKEN}); replacing the Nucleus service rather than charging a task: ${original instanceof Error ? original.message : String(original)}`);
  }
}

let loginSessionFaultHandler: (() => void) | null = null;
/** The standalone service registers drain here; `gh` OSStatus faults call it. */
export function onLoginSessionFault(handler: (() => void) | null) { loginSessionFaultHandler = handler; }
export function notifyLoginSessionFault() { loginSessionFaultHandler?.(); }

