import type { ServerResponse } from "node:http";
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
  private readonly streams = new Map<ServerResponse, string>();

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
    for (const [response, session] of this.streams) {
      if (!keep(session)) response.destroy();
    }
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
    if (target.stream && this.streams.size >= 8) {
      response.writeHead(503, { ...headers, "retry-after": "3" }).end();
      return;
    }

    const controller = new AbortController();
    const close = () => controller.abort();
    const deadline = setTimeout(close, requestTimeoutMs);
    response.once("close", close);
    if (target.stream) this.streams.set(response, session);
    try {
      const upstream = await fetch(this.origin + target.path, {
        method: target.method,
        headers: {
          authorization: this.authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });

      if (target.stream) {
        const stream = upstream.body;
        if (
          !upstream.ok ||
          !stream ||
          !upstream.headers.get("content-type")?.startsWith("text/event-stream")
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
        async function* chunks(body: ReadableStream<Uint8Array>) {
          const reader = body.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) return;
              yield value;
            }
          } finally {
            reader.releaseLock();
          }
        }
        await pipeline(chunks(stream), response, { signal: controller.signal });
      } else {
        const couldBePlannerRetry =
          target.method === "POST" && upstream.status === 503;
        if (upstream.status >= 500 && !couldBePlannerRetry) {
          throw new Error("Engine unavailable");
        }
        const json = await upstream.text();
        if (couldBePlannerRetry && json !== plannerAuthorityPending) {
          throw new Error("Engine unavailable");
        }
        response.writeHead(upstream.status, {
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
      this.streams.delete(response);
      controller.abort();
    }
  }
}
