import {
  Agent,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { text } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";

export type RustBoardConfig = { url: string; key: string };

export function configuredRustBoard(
  env: NodeJS.ProcessEnv,
): RustBoardConfig | null {
  const url = env.NUCLEUS_BOARD_ENGINE_URL;
  const key = env.NUCLEUS_BOARD_ENGINE_KEY;
  return url && key ? { url, key } : null;
}

const prefix = "/api/engine";
const requestTimeoutMs = 10_000;
const streamTimeoutMs = 45_000;
const plannerAuthorityPending = JSON.stringify({
  error: "planner authority is not yet known. Retry shortly.",
});

/** Only the task board surface can use the paired session's controller. */
export function rustBoardRoute(
  url: URL,
): { path: string; method: "GET" | "POST"; stream: boolean } | null {
  if (!url.pathname.startsWith(prefix + "/")) return null;
  const route = url.pathname.slice(prefix.length);
  if ((route === "/tasks" || route === "/events") && !url.search) {
    return { path: "/v1" + route, method: "GET", stream: route === "/events" };
  }

  const task =
    /^\/tasks\/([a-zA-Z0-9-]{1,64})(?:\/(next|history|commands))?$/.exec(route);
  if (!task) return null;
  const [, id, action] = task;
  const search = new URLSearchParams();
  if (action === "history") {
    for (const [key, value] of url.searchParams) {
      if (
        search.has(key) ||
        (key !== "before" && key !== "limit") ||
        !/^\d{1,16}$/.test(value)
      )
        return null;
      search.set(key, value);
    }
  } else if (url.search) {
    return null;
  }

  const suffix = action ? "/" + action : "";
  const query = search.size ? "?" + search : "";
  return {
    path: "/v1/tasks/" + id + suffix + query,
    method: action === "commands" ? "POST" : "GET",
    stream: false,
  };
}

export class RustBoardProxy {
  private readonly origin: string;
  private readonly authorization: string;
  private readonly agent = new Agent({ keepAlive: true });
  private readonly active = new Map<
    ServerResponse,
    { controller: AbortController; streamSession: string | null }
  >();
  private closed = false;

  constructor(config: RustBoardConfig) {
    const url = URL.parse(config.url);
    if (
      !url ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !/^[a-f0-9]{64}$/i.test(config.key)
    ) {
      throw new Error(
        "The Rust board needs a loopback HTTP address and a valid controller key.",
      );
    }
    this.origin = url.origin;
    this.authorization = "Bearer " + config.key;
  }

  closeStreams(keep: (session: string) => boolean = () => false) {
    for (const [response, { controller, streamSession }] of this.active) {
      if (streamSession === null || keep(streamSession)) continue;
      controller.abort();
      response.destroy();
    }
  }

  close() {
    this.closed = true;
    for (const [response, { controller }] of this.active) {
      controller.abort();
      response.destroy();
    }
    this.agent.destroy();
  }

  async forward({
    target,
    response,
    session,
    headers,
    body,
  }: {
    target: NonNullable<ReturnType<typeof rustBoardRoute>>;
    response: ServerResponse;
    session: string;
    headers: Record<string, string>;
    body?: string;
  }) {
    if (this.closed || response.destroyed) {
      response.destroy();
      return;
    }
    if (
      target.stream &&
      [...this.active.values()].filter(
        ({ streamSession }) => streamSession !== null,
      ).length >= 8
    ) {
      response.writeHead(503, { ...headers, "retry-after": "3" }).end();
      return;
    }

    const controller = new AbortController();
    const close = () => controller.abort();
    const deadline = setTimeout(close, requestTimeoutMs);
    response.once("close", close);
    this.active.set(response, {
      controller,
      streamSession: target.stream ? session : null,
    });
    try {
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = request(
          this.origin + target.path,
          {
            agent: this.agent,
            method: target.method,
            headers: {
              authorization: this.authorization,
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            signal: controller.signal,
          },
          resolve,
        );
        outgoing.once("error", reject);
        outgoing.end(body);
      });
      const status = upstream.statusCode ?? 502;
      if (status >= 300 && status < 400) throw new Error("Unexpected redirect");

      if (target.stream) {
        if (
          status < 200 ||
          status >= 300 ||
          !upstream.headers["content-type"]?.startsWith("text/event-stream")
        ) {
          throw new Error("Invalid engine stream");
        }
        clearTimeout(deadline);
        response.setTimeout(streamTimeoutMs, () => response.destroy());
        response.writeHead(200, {
          ...headers,
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.flushHeaders();
        await pipeline(upstream, response, { signal: controller.signal });
      } else {
        const couldBePlannerRetry = target.method === "POST" && status === 503;
        if (status >= 500 && !couldBePlannerRetry) {
          throw new Error("Engine unavailable");
        }
        const json = await text(upstream);
        if (couldBePlannerRetry && json !== plannerAuthorityPending) {
          throw new Error("Engine unavailable");
        }
        response.writeHead(status, {
          ...headers,
          "content-type": "application/json; charset=utf-8",
        });
        response.end(json);
      }
    } catch {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, {
          ...headers,
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({ error: "The task engine is unavailable." }),
        );
      } else if (!response.destroyed) {
        response.destroy();
      }
    } finally {
      clearTimeout(deadline);
      response.off("close", close);
      this.active.delete(response);
      controller.abort();
    }
  }
}
