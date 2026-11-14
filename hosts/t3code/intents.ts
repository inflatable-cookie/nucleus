import { createHash } from 'node:crypto';
import { HostUnknownDeliveryError, ProvenPreSendRefusalError, sanitizeHostDeliveryDiagnostic } from '../../core/host';
import type { T3RpcClient } from './rpc';
import { T3RpcError } from './rpc';
import { T3CompatibilityError } from './contracts';
import { canonical, type T3State, type T3StateFile, type T3IntentKind } from './state';

/** A command identity: the same purpose and fact always name the same command. */
export const identity = (purpose: string, value: string) => `nucleus-${purpose}-${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;

/** One command payload as recorded in the ledger, and the kind it is. */
type RecordedWire = { method?: string; payload?: { type?: unknown; threadId?: unknown; commandId?: unknown; requestId?: unknown; title?: unknown } };

/** The kind of one ledger entry, derived once from the wire when a legacy entry has none. */
export function intentKindOf(intent: T3State['intents'][string]): T3IntentKind | undefined {
  if (intent.kind) return intent.kind;
  return kindOfWire(intent.payload);
}

/** Whether this entry records the named command. */
export function isIntent(kind: T3IntentKind, intent: T3State['intents'][string] | undefined): boolean {
  return Boolean(intent) && intentKindOf(intent!) === kind;
}

/** The thread one entry addresses, from the record or, for a legacy entry, from its wire. */
export function intentThreadId(intent: T3State['intents'][string]): string | undefined {
  if (intent.threadId) return intent.threadId;
  try {
    const payload = (JSON.parse(intent.payload) as RecordedWire).payload;
    return typeof payload?.threadId === 'string' ? payload.threadId : undefined;
  } catch {
    return undefined;
  }
}

/** The kind one command's payload names, for the ledger to record at reserve time. */
export function intentKindOfPayload(method: string, payload: unknown): T3IntentKind {
  if (method === 'orchestration.launchThread') return 'launchThread';
  if (method === 'projects.mutate') return (payload as { type?: unknown } | null)?.type === 'project.update' ? 'project.update' : 'project.create';
  const kind = ((payload as { type?: unknown } | null)?.type ?? '') as T3IntentKind;
  return kind;
}

/** The thread one command payload addresses, when it names one. */
export function threadIdOfPayload(payload: unknown): string | undefined {
  const threadId = (payload as { threadId?: unknown } | null)?.threadId;
  return typeof threadId === 'string' ? threadId : undefined;
}

function kindOfWire(encoded: string): T3IntentKind | undefined {
  try {
    const wire = JSON.parse(encoded) as RecordedWire;
    if (wire.method === 'orchestration.launchThread') return 'launchThread';
    if (wire.method === 'projects.mutate') return wire.payload?.type === 'project.update' ? 'project.update' : 'project.create';
    if (wire.method !== 'orchestration.dispatchCommand' || typeof wire.payload?.type !== 'string') return undefined;
    return wire.payload.type as T3IntentKind;
  } catch {
    return undefined;
  }
}

/**
 * The thread a presentation intent addresses, when the recorded command is only
 * presentation. A `thread.metadata.update` counts only when the title is the
 * whole command: a metadata update that changes anything else is not ours to
 * retire.
 */
export function presentationThread(intent: T3State['intents'][string]): string | undefined {
  const kind = intentKindOf(intent), threadId = intentThreadId(intent);
  if (!threadId) return undefined;
  if (kind !== 'thread.settle' && kind !== 'thread.unsettle' && kind !== 'thread.metadata.update') return undefined;
  if (kind !== 'thread.metadata.update') return threadId;
  // Only a title-only metadata update is presentation: anything else changes a
  // thread fact this host does not own the retirement of.
  try {
    const payload = (JSON.parse(intent.payload) as RecordedWire).payload;
    return typeof payload?.title === 'string' && Object.keys(payload).every(key => ['type', 'commandId', 'threadId', 'title'].includes(key)) ? threadId : undefined;
  } catch {
    /* Malformed or non-presentation intents remain untouched. */
    return undefined;
  }
}

interface ProjectCreateWire { method?: string; payload?: { type?: unknown; commandId?: unknown; projectId?: unknown; workspaceRoot?: unknown; title?: unknown } }
/**
 * Nightly moved project registration from a `project.create` command inside
 * `orchestration.dispatchCommand` to a `projects.mutate` mutation. An unknown
 * intent recorded before that change may carry the identical create on the old
 * route; the command and project IDs are unchanged, so the inventory re-read
 * adopts a landed project and T3's command receipt keeps a resend idempotent.
 * Nothing else may change an intent's payload.
 */
function projectCreateRouteMigrated(previous: string, current: string): boolean {
  try {
    const before = JSON.parse(previous) as ProjectCreateWire, after = JSON.parse(current) as ProjectCreateWire;
    const route = (wire: ProjectCreateWire) => wire.method === 'projects.mutate' || wire.method === 'orchestration.dispatchCommand' ? wire.method : null;
    const create = (wire: ProjectCreateWire) => wire.payload && wire.payload.type === 'project.create'
      && typeof wire.payload.commandId === 'string' && typeof wire.payload.projectId === 'string'
      && typeof wire.payload.workspaceRoot === 'string' && typeof wire.payload.title === 'string'
      ? { commandId: wire.payload.commandId, projectId: wire.payload.projectId, workspaceRoot: wire.payload.workspaceRoot, title: wire.payload.title } : null;
    const beforeRoute = route(before), afterRoute = route(after), beforeCreate = create(before), afterCreate = create(after);
    if (!beforeRoute || !afterRoute || !beforeCreate || !afterCreate || beforeRoute === afterRoute) return false;
    return canonical(beforeCreate) === canonical(afterCreate);
  } catch { return false; }
}

/** Includes pre-binding ledgers so upgrading cannot permit a second response. */
function responseIntents(state: T3State, agentId: string, requestId: string) {
  return Object.entries(state.intents).filter(([, intent]) => {
    if (intent.response) return intent.response.agentId === agentId && intent.response.requestId === requestId;
    const kind = intentKindOf(intent);
    if (kind !== 'runtime-request.respond' && kind !== 'thread.user-input.dismiss') return false;
    if (intentThreadId(intent) !== agentId) return false;
    try { return (JSON.parse(intent.payload) as RecordedWire).payload?.requestId === requestId; }
    catch { throw Error('T3Code durable intent is unreadable; response delivery is unknown'); }
  });
}

type ResponseBinding = NonNullable<T3State['intents'][string]['response']>;

/** What the ledger needs from the host that owns the connection and its durable identity. */
export interface T3IntentContext {
  rpc: T3RpcClient;
  state: T3StateFile;
  /** The durable host identity this connection proved; empty before connect. */
  hostId(): string;
  requireConnection(): void;
}

export interface EffectOptions {
  /** Caller completed a fresh positive read that reconciles the unknown remote effect. */
  resendUnknownAfterRead?: boolean;
  /** Retry only a recorded local pre-send refusal, keeping the same payload and command identity. */
  retryRefusedBeforeSend?: boolean;
  /** Guidance that rides an unknown delivery when the remote text names no known method. */
  unsupportedMethodGuidance?: string;
}

export interface ResponseEffect { binding: ResponseBinding; prepare(): Promise<unknown> }

/**
 * The intent ledger: one durable record per command, written before the send,
 * read back before any repeat.
 *
 * Every entry carries the kind of command it is, recorded once when the command
 * is reserved, so a reader decides from a typed fact instead of re-parsing the
 * stored payload. An entry written before this field existed derives its kind
 * here, in the one place that reads the wire: `intentKindOf`.
 *
 * The rule the ledger enforces is the delivery contract: a command is sent at
 * most once unless a caller proves by a fresh positive read that its effect did
 * not land, a proven pre-send refusal may be retried with the same identity, and
 * an unknown outcome stays unknown.
 */
export class T3IntentLedger {
  constructor(private readonly core: T3IntentContext) {}

  /** Only our recorded delete can retire presentation work; external disappearance cannot. */
  confirmedDeletion(state: T3State, id: string): string | undefined {
    const key = identity('delete', id), intent = state.intents[key];
    if (!intent || intent.status !== 'settled' && !(intent.status === 'unknown' && intent.deletionObservedAt)) return undefined;
    if (!isIntent('thread.delete', intent) || intentThreadId(intent) !== id) return undefined;
    try {
      return (JSON.parse(intent.payload) as RecordedWire).payload?.commandId === key ? key : undefined;
    } catch { /* An unreadable intent proves no deletion. */ }
    return undefined;
  }

  async effect(key: string, method: string, payload: unknown, beforeSend?: () => void,
    response?: ResponseEffect, options: EffectOptions = {}): Promise<unknown> {
    const { state, rpc } = this.core;
    if (!response && !options.retryRefusedBeforeSend) this.core.requireConnection();
    let encoded = canonical({ method, payload });
    const kind = intentKindOfPayload(method, payload), threadId = threadIdOfPayload(payload);
    const reserved = state.update(current => {
      const matches = response ? responseIntents(current, response.binding.agentId, response.binding.requestId) : [];
      const possibleWrites = matches.filter(([, intent]) => intent.status !== 'refused' || !intent.response);
      if (possibleWrites.length > 1) throw new HostUnknownDeliveryError(possibleWrites.find(([, intent]) => intent.diagnostic)?.[1].diagnostic);
      const [boundKey, old] = possibleWrites[0] ?? matches.find(([id]) => id === key) ?? [key, current.intents[key]];
      if (old?.status === 'moot') throw new ProvenPreSendRefusalError('T3Code presentation intent retired after confirmed deletion');
      // Inspect the original outcome before payload checks or native status reads.
      if (old?.status === 'unknown' && !options.resendUnknownAfterRead || old?.status === 'refused' && matches.length && !old.response)
        throw new HostUnknownDeliveryError(old.diagnostic);
      if (!response && options.retryRefusedBeforeSend) {
        // Read the ledger before connection preflight: a prior unknown effect
        // stays unknown even offline. Only an absent or refused intent proves
        // this failure preceded any possible delivery. Settled receipts still
        // require the same authenticated host before they can be replayed.
        try { this.core.requireConnection(); }
        catch (error) {
          if (error instanceof T3CompatibilityError && (!old || old.status === 'refused'))
            throw new ProvenPreSendRefusalError('T3Code connection unavailable before effect reservation');
          throw error;
        }
      }
      if (old && matches.length) {
        const wire = JSON.parse(old.payload).payload;
        const legacyInput = canonical({ type: wire.type, response: wire.type === 'runtime-request.respond'
          ? { ...(wire.decision !== undefined ? { decision: wire.decision } : {}), ...(wire.answers !== undefined ? { answers: wire.answers } : {}) } : {} });
        const original = old.response ?? { agentId: wire.threadId, requestId: wire.requestId,
          workspaceId: current.agents[wire.threadId]?.workspaceId, input: legacyInput };
        if (original.workspaceId !== response!.binding.workspaceId || original.input !== response!.binding.input)
          throw new ProvenPreSendRefusalError(`T3Code original runtime response is ${old.status}; changed answer was not sent`);
      } else if (old && old.payload !== encoded && !projectCreateRouteMigrated(old.payload, encoded))
        throw new ProvenPreSendRefusalError('T3Code intent payload changed');
      if (!old || old.status === 'refused' && options.retryRefusedBeforeSend) {
        if (response || !options.retryRefusedBeforeSend) this.core.requireConnection();
        current.intents[boundKey] = { ...old, payload: encoded, kind, threadId, status: 'unknown', ...(response ? { response: response.binding } : {}) };
      } else if (response && (!this.core.hostId() || current.hostId !== this.core.hostId())) {
        throw Error('T3Code prior response requires its recorded host identity; no command was resent');
      }
      return { key: boundKey, prior: old };
    });
    key = reserved.key; const prior = reserved.prior;
    if (prior?.status === 'settled') return prior.result;
    if (prior?.status === 'refused' && !options.retryRefusedBeforeSend) throw new ProvenPreSendRefusalError('T3Code command was refused; no retry');
    if (prior && !(prior.status === 'unknown' && options.resendUnknownAfterRead)
      && !(prior.status === 'refused' && options.retryRefusedBeforeSend)) throw new HostUnknownDeliveryError(prior.diagnostic);
    let wrote = false;
    try {
      if (response) {
        payload = await response.prepare();
        encoded = canonical({ method, payload });
        state.update(current => { current.intents[key].payload = encoded; });
      }
      beforeSend?.();
      wrote = true;
      const result = await rpc.call(method, payload);
      state.update(current => { if (current.intents[key]?.status !== 'moot') current.intents[key] = { ...current.intents[key], kind, threadId, payload: encoded, status: 'settled', result }; });
      return result;
    } catch (error) {
      // Only a local fence proves non-delivery. The remote text that names no known
      // method cannot prove a phase either (a handler can emit it after an effect),
      // so it stays unknown delivery; the task keeps the path-and-manual-fix
      // guidance and the recorded intent is never marked refused.
      const refusal = error instanceof ProvenPreSendRefusalError ? error
        : !wrote || error instanceof T3RpcError && error.delivery === 'not_sent'
          ? new ProvenPreSendRefusalError(error instanceof T3RpcError ? error.message : 'T3Code send fence refused before delivery') : null;
      if (refusal) state.update(current => { if (current.intents[key]?.status !== 'moot') current.intents[key] = { ...current.intents[key], kind, threadId, payload: encoded, status: 'refused' }; });
      if (refusal) throw refusal;
      const guidance = !refusal && options.unsupportedMethodGuidance && error instanceof T3RpcError && error.code === 'unsupported_method'
        ? options.unsupportedMethodGuidance : undefined;
      const diagnostic = sanitizeHostDeliveryDiagnostic(error instanceof T3RpcError ? { command: error.command, reason: error.reason, guidance }
        : error instanceof HostUnknownDeliveryError ? error.diagnostic : undefined);
      const unknown = new HostUnknownDeliveryError(diagnostic);
      try { state.update(current => { if (current.intents[key]?.status !== 'moot') current.intents[key] = { ...current.intents[key], kind, threadId, diagnostic }; }); }
      catch (persistenceError) { unknown.cause = persistenceError; }
      throw unknown;
    }
  }
}
