import { SAFE_REMOTE_TAGS, sanitizeHostFailureReason } from '../../core/host';

export interface T3ConnectionConfig {
  endpoint: string;
  bearer: string;
  timeoutMs?: number;
}

/** Errors deliberately exclude remote error bodies, request data and ticket URLs. */
export class T3RpcError extends Error {
  readonly command?: string;
  readonly field?: string;
  /** The bounded, sanitized why: a whitelisted tag, a defect shape or an HTTP status. */
  readonly reason?: string;

  constructor(
    readonly code: 'auth' | 'transport' | 'timeout' | 'protocol' | 'remote' | 'unsupported_method',
    readonly method?: string,
    readonly remoteTag?: string,
    readonly delivery: 'not_sent' | 'unknown' = 'unknown',
    diagnostic?: { command?: unknown; field?: unknown; reason?: unknown },
  ) {
    const command = safeCommand(diagnostic?.command);
    const field = safeField(diagnostic?.field);
    const reason = sanitizeHostFailureReason(diagnostic?.reason);
    super(`T3Code ${code}${method ? `: ${method}` : ''}${remoteTag ? ` (${remoteTag})` : ''}${command ? `, command ${command}` : ''}${field ? `, field ${field}` : ''}${reason ? `, reason ${reason}` : ''}`);
    this.name = 'T3RpcError';
    this.command = command;
    this.field = field;
    this.reason = reason;
  }
}

type Pending = {
  method: string;
  command?: string;
  accept?: (value: unknown) => boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  values: number;
};
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_VALUES = 10_000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const REMOTE_TAGS = new Set(SAFE_REMOTE_TAGS);
const safeTag = (value: unknown): string | undefined => typeof value === 'string' && REMOTE_TAGS.has(value) ? value : undefined;
const COMMANDS = new Set([
  'thread.create', 'thread.stop', 'thread.archive', 'message.dispatch', 'project.create',
  'runtime-request.respond', 'thread.user-input.dismiss', 'orchestration.launchThread',
]);
const safeCommand = (value: unknown): string | undefined => typeof value === 'string' && COMMANDS.has(value) ? value : undefined;
function safeField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,6}\])*$/.test(value)) return undefined;
  return value.split(/\.|\[/).length <= 8 ? value : undefined;
}

/** Extract locations only; the formatted expected/actual value is never retained. */
function schemaFieldDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32_768) return undefined;
  const lines = value.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (!/^(?:Missing key|Expected [^\n]+)$/.test(lines[i - 1]!)) continue;
    const location = /^  at ((?:\["[A-Za-z_][A-Za-z0-9_]{0,63}"\]|\[\d{1,6}\])+)$/.exec(lines[i]!);
    if (!location) continue;
    const parts = [...location[1]!.matchAll(/\["([A-Za-z_][A-Za-z0-9_]{0,63})"\]|\[(\d{1,6})\]/g)];
    const field = parts.map((part, index) => part[1] === undefined ? `[${part[2]}]` : `${index ? '.' : ''}${part[1]}`).join('');
    const safe = safeField(field);
    if (safe) return safe;
  }
  return undefined;
}

/**
 * The nightly has no authenticated decode-phase tag; remote failure text cannot prove non-delivery.
 * The retained reason is a value-free fact only: the known tag, a fixed
 * failure-shape name from the adapter's own constants, or both. No remote
 * string — bearer, identifier, method, scope name or any part of a defect —
 * is copied into a diagnostic. The field check alone keeps the configured
 * bearer out of a retained location name.
 */
const DEFECT_SHAPES: readonly { shape: RegExp; name: string }[] = [
  { shape: /^Unknown request tag:/, name: 'unknown_request_tag' },
  { shape: /^Missing key/, name: 'schema_missing_key' },
  { shape: /^Expected/, name: 'schema_expected' },
  { shape: /^Failed to encode response for RPC/, name: 'encoder_rejected' },
];
const TYPED_SHAPES: readonly { tag: string; shape: RegExp; name: string }[] = [
  { tag: 'ProjectMutationError', shape: /^Failed to mutate project\.$/, name: 'project_mutation_failed' },
  { tag: 'ProjectMutationError', shape: /^Project .* is not empty\.$/, name: 'project_not_empty' },
  { tag: 'EnvironmentAuthorizationError', shape: /^The authenticated token is missing required scope:/, name: 'scope_missing' },
];
function remoteFailure(method: string, cause: unknown, command?: string, bearer?: string): Error {
  if (!Array.isArray(cause) || cause.length !== 1 || !object(cause[0])) return new T3RpcError('remote', method, undefined, 'unknown', { command });
  const reason = cause[0];
  if (reason._tag === 'Die') {
    if (reason.defect === `Unknown request tag: ${method}`) return new T3RpcError('unsupported_method', method, undefined, 'unknown', { command, reason: 'unknown_request_tag' });
    const field = schemaFieldDiagnostic(reason.defect);
    const defect = typeof reason.defect === 'string' ? reason.defect : undefined;
    const shape = defect ? DEFECT_SHAPES.find(entry => entry.shape.test(defect))?.name ?? 'remote_failure' : 'remote_failure';
    return new T3RpcError('remote', method, undefined, 'unknown', {
      command,
      field: field && (!bearer || !field.includes(bearer)) ? field : undefined,
      reason: shape,
    });
  }
  const tag = reason._tag === 'Fail' && object(reason.error) ? safeTag(reason.error._tag) : undefined;
  const message = reason._tag === 'Fail' && object(reason.error) && typeof reason.error.message === 'string' && reason.error.message.length <= 512
    ? reason.error.message : undefined;
  const reportedCommand = tag === 'OrchestrationV2DispatchCommandError' && object(reason.error) ? safeCommand(reason.error.commandType) : undefined;
  // An unknown tag is not a fact we can name; the failure stays unknown with no
  // reason at all. A known tag keeps the tag, plus the fixed shape name when
  // the failure matches one.
  if (!tag) return new T3RpcError('remote', method, undefined, 'unknown', { command: reportedCommand ?? command });
  const typed = TYPED_SHAPES.find(entry => entry.tag === tag && typeof message === 'string' && entry.shape.test(message));
  return new T3RpcError('remote', method, tag, 'unknown', {
    command: reportedCommand ?? command,
    reason: typed ? `${tag}:${typed.name}` : tag,
  });
}

/** Small, non-retrying client for the nightly's Effect RPC JSON transport. */
export class T3RpcClient {
  private readonly base: URL;
  readonly #bearer: string;
  private readonly timeoutMs: number;
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private connectAbort: AbortController | null = null;
  private epoch = 0;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(config: T3ConnectionConfig) {
    let base: URL;
    try { base = new URL(config.endpoint); } catch { throw new Error('T3Code requires a valid endpoint in local configuration'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !config.bearer) throw new Error('T3Code requires an endpoint and session bearer in local configuration');
    base.protocol = base.protocol === 'wss:' ? 'https:' : base.protocol === 'ws:' ? 'http:' : base.protocol;
    this.base = new URL(base.origin);
    this.#bearer = config.bearer;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('T3Code request timeout must be positive');
  }

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  toJSON(): { endpoint: string; connected: boolean } { return { endpoint: this.base.origin, connected: this.connected }; }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.open(this.epoch).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async open(epoch: number): Promise<void> {
    const controller = new AbortController();
    this.connectAbort = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let ticket: string;
    try {
      const response = await fetch(new URL('/api/auth/websocket-ticket/rpc', this.base), {
        method: 'POST', headers: { Authorization: `Bearer ${this.#bearer}` }, signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new T3RpcError('auth', undefined, undefined, 'not_sent', { reason: `HTTP ${response.status}` });
      if (!response.ok) throw new T3RpcError('transport', undefined, undefined, 'not_sent', { reason: `HTTP ${response.status}` });
      if (!response.body) throw new T3RpcError('protocol', undefined, undefined, 'not_sent');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 65_536) { await reader.cancel(); throw new T3RpcError('protocol', undefined, undefined, 'not_sent'); }
        chunks.push(item.value);
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      const body = new TextDecoder().decode(combined);
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw new T3RpcError('protocol', undefined, undefined, 'not_sent'); }
      if (!object(value) || typeof value.ticket !== 'string' || !value.ticket) throw new T3RpcError('protocol', undefined, undefined, 'not_sent');
      ticket = value.ticket;
    } catch (error) {
      if (error instanceof T3RpcError) throw error;
      throw new T3RpcError(timedOut ? 'timeout' : 'transport', undefined, undefined, 'not_sent');
    } finally {
      clearTimeout(timer);
      if (this.connectAbort === controller) this.connectAbort = null;
    }
    if (this.epoch !== epoch) throw new T3RpcError('transport', undefined, undefined, 'not_sent');

    const url = new URL('/ws', this.base);
    url.protocol = this.base.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('wsTicket', ticket);
    url.searchParams.set('orchestrationProtocol', '2');
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      const fail = (code: 'timeout' | 'transport') => {
        clearTimeout(connectTimer);
        if (this.socket === socket) {
          this.socket = null;
          this.failAll(new T3RpcError(code));
        }
        reject(new T3RpcError(code, undefined, undefined, 'not_sent'));
        try { socket.close(); } catch { /* already closed */ }
      };
      const connectTimer = setTimeout(() => fail('timeout'), this.timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
      socket.addEventListener('error', () => fail('transport'));
      socket.addEventListener('close', () => fail('transport'));
      socket.addEventListener('message', event => {
        if (this.socket !== socket) return;
        if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_BYTES) return this.broken();
        try {
          const decoded: unknown = JSON.parse(event.data);
          const frames = Array.isArray(decoded) ? decoded : [decoded];
          if (frames.length > MAX_STREAM_VALUES) return this.broken();
          for (const frame of frames) this.receive(frame);
        } catch { this.broken(); }
      });
    });
  }

  close(): void {
    this.epoch++;
    this.connectAbort?.abort();
    const socket = this.socket;
    this.socket = null;
    this.failAll(new T3RpcError('transport'));
    try { socket?.close(); } catch { /* already closed */ }
  }

  call(method: string, payload: unknown): Promise<unknown> { return this.request(method, payload); }

  readStream(method: string, payload: unknown, accept: (value: unknown) => boolean): Promise<unknown> {
    return this.request(method, payload, accept);
  }

  private request(method: string, payload: unknown, accept?: (value: unknown) => boolean): Promise<unknown> {
    if (!/^[A-Za-z][A-Za-z0-9.]{0,100}$/.test(method)) return Promise.reject(new T3RpcError('protocol', undefined, undefined, 'not_sent'));
    if (!this.connected) return Promise.reject(new T3RpcError('transport', method, undefined, 'not_sent'));
    let data: string;
    const id = String(this.nextId++);
    try { data = JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] }); }
    catch { return Promise.reject(new T3RpcError('protocol', method, undefined, 'not_sent')); }
    if (data.length > MAX_FRAME_BYTES) return Promise.reject(new T3RpcError('protocol', method, undefined, 'not_sent'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(new T3RpcError('timeout', method));
        this.close();
      }, this.timeoutMs);
      const command = object(payload) ? safeCommand(payload.type) : undefined;
      this.pending.set(id, { method, command: command ?? (method === 'orchestration.launchThread' ? method : undefined), accept, resolve, reject, timer, values: 0 });
      try { this.socket!.send(data); }
      catch { this.settle(id, new T3RpcError('transport', method), true); }
    });
  }

  private receive(frame: unknown): void {
    if (!object(frame) || typeof frame._tag !== 'string') return this.broken();
    if (frame._tag === 'Pong') return;
    if (frame._tag === 'Ping') { this.sendControl({ _tag: 'Pong' }); return; }
    if (frame._tag === 'Defect') return this.broken();
    if (typeof frame.requestId !== 'string' && typeof frame.requestId !== 'number') return this.broken();
    const id = String(frame.requestId);
    const pending = this.pending.get(id);
    if (!pending) return; // A final Exit may follow our stream Interrupt.
    if (frame._tag === 'Chunk') {
      if (!pending.accept || !Array.isArray(frame.values)) return this.broken();
      this.sendControl({ _tag: 'Ack', requestId: id });
      for (const value of frame.values) {
        if (++pending.values > MAX_STREAM_VALUES) return this.broken();
        let accepted: boolean;
        try { accepted = pending.accept(value); }
        catch (error) { this.sendControl({ _tag: 'Interrupt', requestId: id }); this.settle(id, error, true); return; }
        if (accepted) {
          this.sendControl({ _tag: 'Interrupt', requestId: id });
          this.settle(id, value, false);
          return;
        }
      }
      return;
    }
    if (frame._tag === 'Exit' && object(frame.exit)) {
      if (frame.exit._tag === 'Failure') return this.settle(id, remoteFailure(pending.method, frame.exit.cause, pending.command, this.#bearer), true);
      if (frame.exit._tag === 'Success') return this.settle(id, pending.accept ? new T3RpcError('protocol', pending.method) : frame.exit.value, Boolean(pending.accept));
    }
    if (frame._tag === 'Interrupt') return this.settle(id, new T3RpcError('transport', pending.method), true);
    this.broken();
  }

  private sendControl(frame: unknown): void { try { if (this.connected) this.socket!.send(JSON.stringify(frame)); } catch { this.broken(); } }
  private settle(id: string, value: unknown, failed: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (failed) pending.reject(value); else pending.resolve(value);
  }
  private failAll(error: Error): void { for (const id of [...this.pending.keys()]) this.settle(id, error, true); }
  private broken(): void { this.failAll(new T3RpcError('protocol')); this.close(); }
}
