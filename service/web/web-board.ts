/**
 * Local web board server (service-boundary contract, "Local web board").
 *
 * The standalone service serves the board to a browser on this machine. It binds
 * 127.0.0.1 on a random free port, refuses any Host or Origin that does not name
 * that loopback address, and answers the API only with a bearer token it issued.
 * The RPC route runs the shared catalogue with `via: "web"`, so it passes through
 * the same validation and dispatch as the socket. The live channel is a
 * server-sent event stream that pushes each board revision as the executor
 * publishes it, with the same unchanged-counter acknowledgement the plugin reads.
 *
 * Tokens are minted by the owner socket (`service.ui-link`, `nucleus ui`). They
 * live only in memory, as SHA-256 digests, expire and can be revoked. A request
 * carries its token in an Authorization header. The link carries it in its
 * fragment, which the browser never sends to this server and which the page reads
 * once, on first load. No cookie, query string or log holds the token.
 *
 * This stops other websites and DNS-rebinding pages. It does not stop a process
 * running as the same user that reads a link the owner issued.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { z, ZodError } from "zod";
import { isUnchangedBoard, type UiBoard } from "../../shared/contracts";
import { formatSchemaRefusal } from "../../shared/schema-refusal";
import {
  SETTINGS_SURFACE_HEADER,
  webSettingsRefusal,
} from "../../shared/web-surface";
import {
  CapacityWriteRefusalError,
  MethodNotServedError,
  SurfaceRefusalError,
} from "../transport/dispatch";
import { ExecutorError } from "../executor/executor";
import { MAX_FRAME_BYTES, METHOD_PATTERN, ProtocolError } from "../../shared/service/protocol";
import { sourcePathFromModule } from "../../shared/service/build";

const LOOPBACK = "127.0.0.1";
/** The board bundle directory, relative to the checkout root, served when present. */
export const WEB_BUNDLE_DIR = join("web", "dist");
export const WEB_TOKEN_DEFAULT_MINUTES = 8 * 60;
export const WEB_TOKEN_MAX_MINUTES = 24 * 60;
/** Outstanding tokens are bounded; the oldest is evicted first. */
const MAX_OUTSTANDING_TOKENS = 16;
const MAX_STREAMS = 8;
const STREAM_KEEPALIVE_MS = 15_000;
/** How often open streams re-check that their token is still live. */
const STREAM_TOKEN_CHECK_MS = 30_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The fields an unchanged-board acknowledgement carries, so the live channel matches the plugin's poll. */
const COUNTER_FIELDS = [
  "connected",
  "paused",
  "dispatchHeld",
  "drained",
  "boundRuns",
  "quiet",
  "activeWorkers",
  "unsettled",
  "occupiedSlots",
  "error",
  "stoppedThreads",
  "resumedThreads",
] as const;

/** The owner socket's `service.ui-link` input: mint a link, or revoke every outstanding token. */
export const uiLinkInputSchema = z
  .object({
    action: z.enum(["issue", "revoke"]).default("issue"),
    ttlMinutes: z
      .number()
      .int()
      .min(5)
      .max(WEB_TOKEN_MAX_MINUTES)
      .default(WEB_TOKEN_DEFAULT_MINUTES),
  })
  .strict();
export type UiLinkInput = z.infer<typeof uiLinkInputSchema>;

const rpcBodySchema = z
  .object({
    method: z.string().regex(METHOD_PATTERN),
    input: z.unknown().optional(),
  })
  .strict();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** In-memory token table: digests only, bounded, expiring, revocable. */
export class WebTokens {
  private readonly live = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Mint a token that lives for `ttlMs`. The table keeps only its digest. */
  issue(ttlMs: number): { token: string; expiresAt: number } {
    this.prune();
    while (this.live.size >= MAX_OUTSTANDING_TOKENS) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + ttlMs;
    this.live.set(digest(token), expiresAt);
    return { token, expiresAt };
  }

  /** The digest of a presented token that is live, or null for a missing, malformed, unknown, expired or revoked one. */
  admit(token: string | undefined): string | null {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const key = digest(token);
    return this.isLive(key) ? key : null;
  }

  isLive(key: string): boolean {
    const expiresAt = this.live.get(key);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  /** Revoke every outstanding token; returns how many were live. */
  revokeAll(): number {
    this.prune();
    const revoked = this.live.size;
    this.live.clear();
    return revoked;
  }

  private prune() {
    for (const [key, expiresAt] of this.live)
      if (expiresAt <= this.now()) this.live.delete(key);
  }
}

export interface WebBoardHost {
  /** One catalogue call with `via: "web"`, validated and dispatched as the socket's is. */
  call(method: string, input: unknown): Promise<unknown>;
  /** The latest published board projection, or null before the first publication. */
  board(): UiBoard | null;
  /** Why the board cannot be served right now, or null. */
  unavailable(): string | null;
  /** Subscribe to executor publications; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface WebBoardOptions {
  host: WebBoardHost;
  /** A built bundle to serve; null serves the minimal "not built yet" page. */
  bundleDir?: string | null;
  /** Fixture clock for token expiry; production reads the wall clock. */
  now?: () => number;
}

interface Stream {
  response: ServerResponse;
  /** Digest of the token that opened the stream; the stream closes when it stops being live. */
  key: string;
  sentRevision: number;
  sentCounters: string;
  sentUnavailable: string | null;
  keepalive: NodeJS.Timeout;
}

class BodyTooLarge extends Error {}

export class WebBoard {
  readonly tokens: WebTokens;
  private server: Server | null = null;
  private boundPort = 0;
  private readonly streams = new Set<Stream>();
  private unsubscribe: (() => void) | null = null;
  private tokenTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WebBoardOptions) {
    this.tokens = new WebTokens(options.now);
  }

  /** The loopback address the server listens on, or null when it is not listening. */
  get address(): { host: string; port: number } | null {
    return this.server ? { host: LOOPBACK, port: this.boundPort } : null;
  }

  /** Bind 127.0.0.1 on a random free port and start publishing board revisions. */
  async listen(): Promise<number> {
    const server = createServer((request, response) =>
      this.handle(request, response),
    );
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once("error", onError);
      server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
    const address = server.address();
    if (
      typeof address !== "object" ||
      address === null ||
      address.address !== LOOPBACK
    ) {
      server.close();
      throw new Error(
        `The board server bound ${JSON.stringify(address)} instead of ${LOOPBACK}`,
      );
    }
    this.server = server;
    this.boundPort = address.port;
    this.unsubscribe = this.options.host.subscribe(() => this.publish());
    this.tokenTimer = setInterval(
      () => this.dropRevokedStreams(),
      STREAM_TOKEN_CHECK_MS,
    );
    this.tokenTimer.unref?.();
    return this.boundPort;
  }

  /** Mint a link: the board URL with a fresh token in its fragment. */
  issueLink(ttlMinutes: number): {
    url: string;
    expiresAt: string;
    ttlMinutes: number;
  } {
    const { token, expiresAt } = this.tokens.issue(ttlMinutes * 60_000);
    return {
      url: `http://${LOOPBACK}:${this.boundPort}/#token=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlMinutes,
    };
  }

  /** Revoke every outstanding token and close the streams they opened. */
  revokeAll(): number {
    const revoked = this.tokens.revokeAll();
    this.dropRevokedStreams();
    return revoked;
  }

  /** Stop publishing, end live streams and release the port. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.tokenTimer = null;
    for (const stream of [...this.streams]) stream.response.end();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections?.();
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.route(request, response).catch((error) => {
      if (!response.headersSent)
        sendJson(response, 500, refusal("internal", messageOf(error)));
      else response.end();
    });
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = parseTarget(request.url);
    if (!url) {
      sendJson(
        response,
        400,
        refusal("invalid_input", "The request path is not valid."),
      );
      return;
    }
    // A foreign Host is how a page on another domain reaches a loopback server
    // through DNS rebinding, so the name must be this board's own address.
    if (!this.hostAllowed(request.headers.host)) {
      sendJson(
        response,
        403,
        refusal(
          "host",
          "The Host header must name this board's localhost address.",
        ),
      );
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !this.originAllowed(origin)) {
      sendJson(
        response,
        403,
        refusal(
          "origin",
          "Cross-origin requests are not served; open the board from its own link.",
        ),
      );
      return;
    }
    if (url.pathname === "/api/rpc") return this.rpc(request, response);
    if (url.pathname === "/api/events") return this.events(request, response);
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, refusal("not_found", "No such board route."));
      return;
    }
    if (request.method !== "GET") {
      sendJson(
        response,
        405,
        refusal("method", "The board serves GET for pages and assets."),
      );
      return;
    }
    return this.serveStatic(response, url.pathname);
  }

  private async serveStatic(
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const root = this.options.bundleDir
      ? resolve(this.options.bundleDir)
      : null;
    if (path === "/" || path === "/ui") {
      const index = root
        ? await readFile(join(root, "index.html")).catch(() => null)
        : null;
      if (index)
        sendBytes(response, 200, "text/html; charset=utf-8", index, true);
      else
        sendBytes(
          response,
          200,
          "text/html; charset=utf-8",
          Buffer.from(FALLBACK_PAGE),
          true,
        );
      return;
    }
    if (!root) {
      sendJson(response, 404, refusal("not_found", "No such board asset."));
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(path.slice(1));
    } catch {
      sendJson(
        response,
        400,
        refusal("invalid_input", "The asset path is not valid."),
      );
      return;
    }
    const file = resolve(root, relative);
    const bytes = file.startsWith(root + sep)
      ? await readFile(file).catch(() => null)
      : null;
    if (!bytes) {
      sendJson(response, 404, refusal("not_found", "No such board asset."));
      return;
    }
    sendBytes(
      response,
      200,
      contentType(file),
      bytes,
      extname(file) === ".html",
    );
  }

  private authorize(request: IncomingMessage): string | null {
    const header = request.headers.authorization;
    const match =
      typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
    return this.tokens.admit(match?.[1]);
  }

  private refuseUnauthorized(response: ServerResponse): void {
    sendJson(
      response,
      401,
      refusal(
        "unauthenticated",
        "A valid board token is required. Open a fresh link from `nucleus ui`; missing, unknown, expired and revoked tokens are refused alike.",
      ),
      { "www-authenticate": 'Bearer realm="nucleus-board"' },
    );
  }

  private async rpc(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      sendJson(
        response,
        405,
        refusal("method", "POST one catalogue call to /api/rpc."),
      );
      return;
    }
    if (!this.authorize(request)) return this.refuseUnauthorized(response);
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request, MAX_FRAME_BYTES));
    } catch (error) {
      if (error instanceof BodyTooLarge)
        sendJson(
          response,
          413,
          refusal(
            "oversize",
            `The request body is over the ${MAX_FRAME_BYTES}-byte bound.`,
          ),
          { connection: "close" },
        );
      else
        sendJson(
          response,
          400,
          refusal("invalid_input", "The request body is not JSON."),
        );
      return;
    }
    const call = rpcBodySchema.safeParse(body);
    if (!call.success) {
      sendJson(
        response,
        400,
        refusal("invalid_input", formatSchemaRefusal(call.error)),
      );
      return;
    }
    // A Settings write needs the Settings screen's marker on top of the token; the
    // token alone answers like every other refusal here (no mutation, no retry).
    const settingsRefusal = webSettingsRefusal(
      call.data.method,
      request.headers[SETTINGS_SURFACE_HEADER],
    );
    if (settingsRefusal) {
      sendJson(response, 403, refusal("refused", settingsRefusal));
      return;
    }
    try {
      const result = await this.options.host.call(
        call.data.method,
        call.data.input ?? {},
      );
      sendJson(response, 200, { result });
    } catch (error) {
      const mapped = webError(error);
      sendJson(response, mapped.status, refusal(mapped.code, mapped.message));
    }
  }

  private events(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      sendJson(
        response,
        405,
        refusal("method", "The live channel is a GET stream."),
      );
      return;
    }
    const key = this.authorize(request);
    if (!key) return this.refuseUnauthorized(response);
    if (this.streams.size >= MAX_STREAMS) {
      sendJson(
        response,
        503,
        refusal(
          "busy",
          `The board already has ${MAX_STREAMS} live streams open; close one and retry.`,
        ),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    response.write("retry: 3000\n\n");
    const stream: Stream = {
      response,
      key,
      sentRevision: -1,
      sentCounters: "",
      sentUnavailable: null,
      keepalive: setInterval(() => {
        if (!response.writableEnded) response.write(": keepalive\n\n");
      }, STREAM_KEEPALIVE_MS),
    };
    stream.keepalive.unref?.();
    this.streams.add(stream);
    response.on("close", () => {
      clearInterval(stream.keepalive);
      this.streams.delete(stream);
    });
    this.pushTo(stream);
  }

  /** Send what this stream has not seen yet: the full board when its revision moved, counters when only they moved. */
  private pushTo(stream: Stream): void {
    if (stream.response.writableEnded) return;
    const reason = this.options.host.unavailable();
    if (reason) {
      if (stream.sentUnavailable !== reason) {
        writeEvent(stream, "unavailable", { message: reason });
        stream.sentUnavailable = reason;
        stream.sentRevision = -1;
      }
      return;
    }
    stream.sentUnavailable = null;
    const board = this.options.host.board();
    if (!board || isUnchangedBoard(board)) return;
    const counters = countersOf(board);
    const signature = JSON.stringify(counters);
    if (board.revision !== stream.sentRevision) {
      writeEvent(stream, "board", board, board.revision);
      stream.sentRevision = board.revision;
      stream.sentCounters = signature;
      return;
    }
    if (signature !== stream.sentCounters) {
      writeEvent(stream, "counters", {
        unchanged: true,
        revision: board.revision,
        ...counters,
      });
      stream.sentCounters = signature;
    }
  }

  private publish(): void {
    for (const stream of [...this.streams]) this.pushTo(stream);
  }

  private dropRevokedStreams(): void {
    for (const stream of [...this.streams]) {
      if (!this.tokens.isLive(stream.key)) stream.response.end();
    }
  }

  private hostAllowed(host: string | undefined): boolean {
    return (
      host === `${LOOPBACK}:${this.boundPort}` ||
      host === `localhost:${this.boundPort}`
    );
  }

  private originAllowed(origin: string): boolean {
    return (
      origin === `http://${LOOPBACK}:${this.boundPort}` ||
      origin === `http://localhost:${this.boundPort}`
    );
  }
}

function countersOf(
  board: Exclude<UiBoard, { unchanged: true }>,
): Record<string, unknown> {
  const counters: Record<string, unknown> = {};
  for (const field of COUNTER_FIELDS)
    counters[field] = (board as unknown as Record<string, unknown>)[field];
  return counters;
}

function writeEvent(
  stream: Stream,
  event: string,
  data: unknown,
  id?: number,
): void {
  if (stream.response.writableEnded) return;
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  stream.response.write(
    `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

/** Map a thrown catalogue error to the HTTP status and typed code the web board answers with. */
export function webError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof MethodNotServedError)
    return { status: 404, code: "method_unknown", message: error.message };
  if (error instanceof ZodError)
    return {
      status: 400,
      code: "invalid_input",
      message: formatSchemaRefusal(error),
    };
  if (
    error instanceof CapacityWriteRefusalError ||
    error instanceof SurfaceRefusalError
  )
    return { status: 403, code: "refused", message: error.message };
  if (error instanceof ProtocolError)
    return {
      status: statusFor(error.code),
      code: error.code,
      message: error.message,
    };
  if (error instanceof ExecutorError)
    return {
      status: statusFor(error.code),
      code: error.code,
      message: error.message,
    };
  return { status: 500, code: "internal", message: messageOf(error) };
}

function statusFor(code: string): number {
  switch (code) {
    case "invalid_input":
      return 400;
    case "method_unknown":
      return 404;
    case "refused":
      return 403;
    case "unauthenticated":
      return 401;
    case "oversize":
      return 413;
    case "busy":
    case "timeout":
    case "unavailable":
    case "draining":
      return 503;
    default:
      return 500;
  }
}

function refusal(code: string, message: string) {
  return { error: { code, message } };
}

function parseTarget(target: string | undefined): URL | null {
  try {
    return new URL(target ?? "/", `http://${LOOPBACK}`);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
    sendJson(
      response,
      413,
      refusal(
        "oversize",
        `The response is over the ${MAX_FRAME_BYTES}-byte bound.`,
      ),
    );
    return;
  }
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(text);
}

function sendBytes(
  response: ServerResponse,
  status: number,
  type: string,
  bytes: Buffer,
  page: boolean,
): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": type,
    ...(page
      ? {
          "content-security-policy":
            "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        }
      : {}),
  });
  response.end(bytes);
}

function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentType(file: string): string {
  return (
    CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
  );
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        rejectBody(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    });
  });
}

/** The built board bundle when one is present in the checkout, else null. */
export function defaultWebBundleDir(): string | null {
  try {
    const dir = join(sourcePathFromModule(), WEB_BUNDLE_DIR);
    return existsFile(join(dir, "index.html")) ? dir : null;
  } catch {
    return null;
  }
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const FALLBACK_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nucleus board</title>
<h1>Nucleus board</h1>
<p>The web board isn't built yet. The service is running. Its board API is at <code>/api/rpc</code> and its live channel at <code>/api/events</code>, both behind a token from <code>nucleus ui</code>.</p>
`;
