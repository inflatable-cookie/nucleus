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
export interface HostDeliveryDiagnostic { command?: string; field?: string; reason?: string; guidance?: string; path?: string }

/**
 * Remote error tags the nightly can send, and the canonical, fixed, value-free
 * reason strings that may be persisted. Every variable portion of a remote
 * failure — expected-shape text, identifiers, method and scope names — is
 * dropped at canonicalization: an unquoted secret sitting in any former
 * variable position has nothing left to ride. The transport status keeps its
 * digits because a status code is an independently known value.
 */
export const SAFE_REMOTE_TAGS: readonly string[] = [
  'EnvironmentAuthorizationError', 'OrchestrationV2DispatchCommandError',
  'OrchestrationV2GetThreadProjectionError', 'OrchestrationV2GetShellSnapshotError',
  'OrchestrationV2ThreadLaunchError', 'ProjectMutationError',
];
const SAFE_CANONICAL_REASONS: readonly string[] = [
  'Missing key',
  'Unknown request tag',
  'Expected a different payload shape, got [value]',
  'Failed to encode response for RPC [value]',
  'Failed to mutate project.',
  'Project is not empty.',
  'The authenticated token is missing a required scope.',
  'ProjectMutationError: Failed to mutate project.',
  'ProjectMutationError: Project is not empty.',
  'EnvironmentAuthorizationError: The authenticated token is missing a required scope.',
  ...SAFE_REMOTE_TAGS,
];

/** Whether a reason text is exactly one of the fixed canonical strings (or a transport status). */
export function retainableRemoteReason(text: string): boolean {
  return SAFE_CANONICAL_REASONS.includes(text) || /^HTTP [1-5]\d{2}$/.test(text);
}

/**
 * A typed failure's message may only be canonicalized to a fixed string beside
 * its tag. The structural pass runs first, so quoted values and JSON never
 * reach the shape check; the variable portion (an identifier, a scope name —
 * anywhere a secret could sit) is dropped in favor of the fixed wording.
 */
const SAFE_MESSAGE_SHAPES: readonly { shape: RegExp; fixed: string }[] = [
  { shape: /^Failed to mutate project\.$/, fixed: 'Failed to mutate project.' },
  { shape: /^Project .+ is not empty\.$/, fixed: 'Project is not empty.' },
  { shape: /^The authenticated token is missing required scope: .+\.$/, fixed: 'The authenticated token is missing a required scope.' },
];

export function canonicalRemoteMessage(message: string): string | undefined {
  const text = structuralReasonPass(message);
  if (text === undefined) return undefined;
  return SAFE_MESSAGE_SHAPES.find(entry => entry.shape.test(text))?.fixed;
}

/** Decoder-defect shapes the nightly authors, mapped to fixed value-free strings. */
const SAFE_DEFECT_SHAPES: readonly { shape: RegExp; fixed: string }[] = [
  { shape: /^Missing key$/, fixed: 'Missing key' },
  { shape: /^Expected .*got \[value\]$/, fixed: 'Expected a different payload shape, got [value]' },
  { shape: /^Unknown request tag: .+$/, fixed: 'Unknown request tag' },
  { shape: /^Failed to encode response for RPC \[value\]$/, fixed: 'Failed to encode response for RPC [value]' },
];

export function canonicalRemoteDefect(defect: unknown): string | undefined {
  const text = structuralReasonPass(defect);
  if (text === undefined) return undefined;
  return SAFE_DEFECT_SHAPES.find(entry => entry.shape.test(text))?.fixed;
}

export function retainableRemoteMessage(message: string): boolean {
  return canonicalRemoteMessage(message) !== undefined;
}

/**
 * The bounded why behind a remote failure, or nothing. Remote text is never
 * retained verbatim beyond the fixed canonical strings: JSON structures,
 * quoted spans and the value clause of a decoder message become `[value]`,
 * location segments are dropped (the extracted field already carries them),
 * and only a canonical string survives. Arbitrary handler text — including
 * any unquoted secret it carries — retains nothing. Stripping a known bearer
 * stays the caller's job and must cover every branch that builds a reason.
 */
export function sanitizeHostFailureReason(input: unknown): string | undefined {
  const text = structuralReasonPass(input);
  if (text === undefined || !retainableRemoteReason(text)) return undefined;
  return text;
}

function structuralReasonPass(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  let text = input.length > 4096 ? input.slice(0, 4096) : input;
  text = text.replace(/\s+/g, ' ').trim();
  for (let depth = 0; depth < 8 && /\{[^{}]*\}/.test(text); depth++) text = text.replace(/\{[^{}]*\}/g, '[value]');
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, '[value]');
  text = text.replace(/`(?:[^`\\]|\\.)*`/g, '[value]');
  text = text.replace(/\s+at\s+\[.*$/g, '');
  if (/^Expected\b/.test(text)) text = text.replace(/\bgot\b.*$/g, 'got [value]').trim();
  text = text.replace(/\s+at\s+\[.*$/g, '');
  for (let depth = 0; depth < 8 && /\{[^{}]*\}/.test(text); depth++) text = text.replace(/\{[^{}]*\}/g, '[value]');
  text = text.replace(/^(Failed to encode response for RPC \[value\]):.*$/, '$1');
  text = text.replace(/\[value\](\s*\[value\])+/g, '[value]').replace(/\[\[value\]\]/g, '[value]');
  if (!text || /^(?:\[value\][, ]*)+$/.test(text)) return undefined;
  return text;
}

/** Nucleus-authored remediation text, never remote content. It is bounded but
 * not value-dropped, so the repository identity and the manual fix survive
 * outside the bounded remote-reason budget; the builder caps the path it
 * interpolates so the fix is never the truncated tail.
 */
export function sanitizeHostGuidance(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

/** The task's own complete repository root, carried outside every bounded budget. */
export function sanitizeDiagnosticPath(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\u0000-\u001f]/.test(input)) return undefined;
  return input;
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
  const path = sanitizeDiagnosticPath(value.path);
  return { ...(command ? { command } : {}), ...(field ? { field } : {}), ...(reason ? { reason } : {}), ...(guidance ? { guidance } : {}), ...(path ? { path } : {}) };
}

/** Diagnostic evidence is not proof of non-delivery and never permits a resend. */
export class HostUnknownDeliveryError extends Error {
  readonly diagnostic: HostDeliveryDiagnostic;
  constructor(diagnostic?: HostDeliveryDiagnostic) {
    const clean = sanitizeHostDeliveryDiagnostic(diagnostic);
    super(`Host delivery is unknown; command was not resent${clean.command ? `; command ${clean.command}` : ''}${clean.field ? `; field ${clean.field}` : ''}${clean.reason ? `; reason ${clean.reason}` : ''}${clean.guidance ? `; guidance ${clean.guidance}` : ''}${clean.path ? `; path ${clean.path}` : ''}`);
    this.name = 'HostUnknownDeliveryError';
    this.diagnostic = clean;
  }
}
