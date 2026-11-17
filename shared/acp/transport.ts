/**
 * Spec 065: the agent's one transport, over the callback socket the binding names.
 *
 * It is deliberately small and self-contained: the ACP agent is a standalone process
 * a host launches, so it uses Node's HTTP client directly on the local socket rather
 * than loading the CLI runtime. `signal` is real here — `session/cancel` must stop a
 * held turn at once, not after the long-poll's own timeout.
 */
import { request } from "node:http";
import type { AcpBinding } from "./binding";
import type { AcpMessageReply, AcpMessageRequest, AcpSessionTransport, AcpTurnReply, AcpTurnRequest } from "./agent";

/** Socket margin over the service's own wait, so a long-poll is never cut off by the client. */
export const ACP_SOCKET_MARGIN_MS = 10_000;
/** A message call is a local write plus delivery; the service's own bound is much smaller. */
export const ACP_MESSAGE_TIMEOUT_MS = 30_000;

export function createAcpTransport(binding: AcpBinding): AcpSessionTransport {
  return {
    turn: (input: AcpTurnRequest, signal: AbortSignal) =>
      post<AcpTurnReply>(binding, "/acp-turn", input, { signal, timeoutMs: input.waitMs + ACP_SOCKET_MARGIN_MS }),
    message: (input: AcpMessageRequest) => post<AcpMessageReply>(binding, "/acp-message", input, { timeoutMs: ACP_MESSAGE_TIMEOUT_MS }),
  };
}

/** One authenticated POST on the binding's socket. Never retried: an unknown delivery is not permission. */
function post<T>(binding: AcpBinding, path: string, body: unknown, options: { signal?: AbortSignal; timeoutMs: number }): Promise<T> {
  const payload = JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    const req = request({
      socketPath: binding.socketPath,
      path, method: "POST",
      headers: {
        authorization: `Bearer ${binding.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += String(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(text.trim() || `Nucleus answered ${response.statusCode ?? "no status"}`));
          return;
        }
        try { resolve(JSON.parse(text) as T); }
        catch { reject(new Error("Nucleus answered with bytes that are not JSON")); }
      });
    });
    const abort = () => req.destroy(abortError());
    options.signal?.addEventListener("abort", abort, { once: true });
    req.setTimeout(options.timeoutMs, () => req.destroy(new Error("Nucleus did not answer in time")));
    req.on("error", error => reject(error));
    req.on("close", () => options.signal?.removeEventListener("abort", abort));
    req.end(payload);
  });
}

const abortError = (): Error => Object.assign(new Error("cancelled"), { name: "AbortError" });
