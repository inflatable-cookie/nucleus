/** The adapter failed before issuing an archive request. */
export class ArchiveNotDeliveredError extends Error {
  constructor(cause: unknown) {
    super(`Thread archive was not sent: ${String(cause)}`, { cause });
    this.name = "ArchiveNotDeliveredError";
  }
}
export class ProvenPreSendRefusalError extends Error {
  constructor(readonly reason: string) {
    super(`Reviewer continuation refused before send: ${reason}`);
    this.name = 'ProvenPreSendRefusalError';
  }
}
export interface HostDeliveryDiagnostic { command?: string; field?: string; reason?: string; guidance?: string }

/**
 * Remote error tags the nightly can send. Only these known tags may be named in
 * a diagnostic; the adapter's RPC layer classifies a failure against this fixed
 * list before anything is retained.
 */
export const SAFE_REMOTE_TAGS: readonly string[] = [
  'EnvironmentAuthorizationError', 'OrchestrationV2DispatchCommandError',
  'OrchestrationV2GetThreadProjectionError', 'OrchestrationV2GetShellSnapshotError',
  'OrchestrationV2ThreadLaunchError', 'ProjectMutationError',
];

/**
 * The reason is a value-free fact only, never any remote string: a known remote
 * tag, a fixed failure-shape name the adapter defines (for example
 * `unknown_request_tag`, `schema_missing_key`, `schema_expected`,
 * `project_not_empty`), the two joined as `<tag>:<shape>`, or the ticket
 * exchange's HTTP status. The token shapes admit no spaces, quotes or
 * punctuation beyond the separator, so no part of a remote failure text — and
 * no secret in any position — can survive; the adapter constructs reasons only
 * from its own constants and the fixed tag list.
 */
export function sanitizeHostFailureReason(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input || input.length > 160) return undefined;
  return /^HTTP [1-5]\d{2}$/.test(input)
    || /^[A-Z][A-Za-z0-9]{1,78}Error$/.test(input)
    || /^[a-z][a-z0-9_]{0,62}$/.test(input)
    || /^[A-Z][A-Za-z0-9]{1,78}Error:[a-z][a-z0-9_]{0,62}$/.test(input) ? input : undefined;
}

/**
 * Nucleus-authored remediation text, never remote content. The repository root
 * it names comes from Nucleus's own record, not from T3, so it is preserved
 * exactly — including any whitespace, untruncated — next to the manual fix;
 * only remote-derived fields are bounded, and this is not one.
 */
export function sanitizeHostGuidance(input: unknown): string | undefined {
  return typeof input === 'string' && input ? input : undefined;
}

/** Native names plus a bounded, shape-restricted reason and bounded guidance: never arbitrary remote text. */
export function sanitizeHostDeliveryDiagnostic(input: unknown): HostDeliveryDiagnostic {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof value.command === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value.command) ? value.command : undefined;
  const field = typeof value.field === 'string' && value.field.length <= 128
    && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,6}\])*$/.test(value.field)
    && value.field.split(/\.|\[/).length <= 8 ? value.field : undefined;
  const reason = sanitizeHostFailureReason(value.reason);
  const guidance = sanitizeHostGuidance(value.guidance);
  return { ...(command ? { command } : {}), ...(field ? { field } : {}), ...(reason ? { reason } : {}), ...(guidance ? { guidance } : {}) };
}

/** Diagnostic evidence is not proof of non-delivery and never permits a resend. */
export class HostUnknownDeliveryError extends Error {
  readonly diagnostic: HostDeliveryDiagnostic;
  constructor(diagnostic?: HostDeliveryDiagnostic) {
    const clean = sanitizeHostDeliveryDiagnostic(diagnostic);
    super(`Host delivery is unknown; command was not resent${clean.command ? `; command ${clean.command}` : ''}${clean.field ? `; field ${clean.field}` : ''}${clean.reason ? `; reason ${clean.reason}` : ''}${clean.guidance ? `; guidance ${clean.guidance}` : ''}`);
    this.name = 'HostUnknownDeliveryError';
    this.diagnostic = clean;
  }
}

/**
 * One host call outlived its admission deadline and was abandoned as unknown.
 *
 * The slot it held is freed so the bound keeps bounding, and the call is never
 * resent: the durable intent that asked for it stays the authority, and the
 * ordinary unknown-delivery paths reconcile the late or missing answer. This is
 * a {"kind":"unknown"} outcome for its caller, never a failure to retry now.
 */
export class HostCallAbandonedError extends HostUnknownDeliveryError {
  readonly cls: string;
  readonly holder: string;
  readonly deadlineMs: number;
  constructor(input: { call: string; holder: string; ageMs: number; deadlineMs: number }) {
    super({ command: `paseo.${input.call}`, reason: 'host_call_past_deadline',
      guidance: `${input.holder} held its admission slot for ${Math.round(input.ageMs)} ms, past its ${input.deadlineMs} ms deadline. The outcome is unknown and the call was not resent; reconcile it from recorded state before asking again.` });
    this.name = 'HostCallAbandonedError';
    this.cls = input.call;
    this.holder = input.holder;
    this.deadlineMs = input.deadlineMs;
  }
}
