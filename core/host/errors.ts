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

/** The fixed wire messages a typed failure may retain, before its tag prefix. */
const SAFE_REMOTE_MESSAGE_TEMPLATES: readonly RegExp[] = [
  /^Failed to mutate project\.$/,
  /^Project [A-Za-z0-9_.:\-/]{1,120} is not empty\.$/,
  /^The authenticated token is missing required scope: [A-Za-z0-9: -]{1,80}\.$/,
];

/**
 * Remote text is retained only in these demonstrably safe shapes: the nightly's
 * decoder formats after value-dropping, the RPC transport's own statuses, bare
 * whitelisted error tags, the handlers' fixed failure messages (bare and beside
 * their tag), and nothing else. Arbitrary handler text — including any
 * unquoted secret it may carry — contributes no reason at all.
 */
const SAFE_REASON_SHAPES: readonly RegExp[] = [
  /^Expected .*got \[value\]$/,
  /^Missing key$/,
  /^Unknown request tag: [A-Za-z0-9_.:-]{1,120}$/,
  /^Failed to encode response for RPC \[value\]$/,
  /^HTTP [1-5]\d{2}$/,
  /^[A-Z][A-Za-z0-9]{0,78}Error$/,
  ...SAFE_REMOTE_MESSAGE_TEMPLATES,
  ...SAFE_REMOTE_MESSAGE_TEMPLATES.map(template => new RegExp(`^[A-Z][A-Za-z0-9]{0,78}Error: ${template.source.replace(/^\^/, '').replace(/\$$/, '')}$`)),
];

/**
 * Whether a typed failure's message may ride the reason beside its tag. The
 * structural sanitizer runs first, so quoted values and JSON never reach the
 * template check; anything the templates do not name is dropped.
 */
export function retainableRemoteMessage(message: string): boolean {
  const text = sanitizeHostFailureReason(message);
  return text !== undefined && SAFE_REMOTE_MESSAGE_TEMPLATES.some(template => template.test(text));
}

/**
 * The bounded why behind a remote failure, or nothing. Arbitrary remote text is
 * never retained: JSON structures, quoted spans and the value clause of a
 * decoder message become `[value]`, location segments are dropped (the
 * extracted field already carries them), the encoder-message tail is cut, and
 * only the safe shapes above survive, capped at 240 characters. Stripping a
 * known bearer stays the caller's job and must cover every branch that builds
 * a reason; this boundary then removes whatever values remain.
 */
export function sanitizeHostFailureReason(input: unknown): string | undefined {
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
  if (!SAFE_REASON_SHAPES.some(shape => shape.test(text))) return undefined;
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

/**
 * Nucleus-authored remediation text, never remote content. It is bounded but
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
