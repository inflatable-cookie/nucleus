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
export interface HostDeliveryDiagnostic { command?: string; field?: string; reason?: string }

/**
 * The bounded why behind a remote failure: a whitelisted error tag, a defect
 * message or an HTTP status. Actual values never survive: JSON structures,
 * quoted spans and the value clause of a decoder message all become `[value]`,
 * location segments are dropped (the extracted field already carries them),
 * newlines collapse and the text is capped. Stripping a known bearer stays the
 * caller's job and must cover every branch that builds a reason; this boundary
 * then removes whatever values remain.
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
  text = text.replace(/\[value\](\s*\[value\])+/g, '[value]').replace(/\[\[value\]\]/g, '[value]');
  if (!text || /^(?:\[value\][, ]*)+$/.test(text)) return undefined;
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

/** Native names plus a bounded, value-free reason: never a remote body or stack. */
export function sanitizeHostDeliveryDiagnostic(input: unknown): HostDeliveryDiagnostic {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof value.command === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value.command) ? value.command : undefined;
  const field = typeof value.field === 'string' && value.field.length <= 128
    && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,6}\])*$/.test(value.field)
    && value.field.split(/\.|\[/).length <= 8 ? value.field : undefined;
  const reason = sanitizeHostFailureReason(value.reason);
  return { ...(command ? { command } : {}), ...(field ? { field } : {}), ...(reason ? { reason } : {}) };
}

/** Diagnostic evidence is not proof of non-delivery and never permits a resend. */
export class HostUnknownDeliveryError extends Error {
  readonly diagnostic: HostDeliveryDiagnostic;
  constructor(diagnostic?: HostDeliveryDiagnostic) {
    const clean = sanitizeHostDeliveryDiagnostic(diagnostic);
    super(`Host delivery is unknown; command was not resent${clean.command ? `; command ${clean.command}` : ''}${clean.field ? `; field ${clean.field}` : ''}${clean.reason ? `; reason ${clean.reason}` : ''}`);
    this.name = 'HostUnknownDeliveryError';
    this.diagnostic = clean;
  }
}
