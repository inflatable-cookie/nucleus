import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { RpcContract } from "../../shared/rpc";
import { RPC_CATALOGUE } from "../../shared/rpc-catalogue";
import { SETTINGS_SURFACE_HEADER, SETTINGS_SURFACE_VALUE } from "../../shared/web-surface";

const PROFILE_SAVE_TIMEOUT_MS = 10_000;

/** Exchange the one-time link token for an HttpOnly same-origin session cookie. */
export async function pairWebSession(token?: string, fetcher: typeof fetch = fetch): Promise<{ rustBoard: boolean }> {
  const response = token
    ? await fetcher("/api/pair", { method: "POST", headers: { authorization: `Bearer ${token}` } })
    : await fetcher("/api/session");
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    const message = error && typeof error === "object" && "message" in error ? error.message : null;
    throw new Error(typeof message === "string" ? message : `Board session check failed (${response.status})`);
  }
  return { rustBoard: Boolean(body && typeof body === "object" && "rustBoard" in body && body.rustBoard === true) };
}

function waitForService(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 3000));
}

/** A paired board uses the browser's HttpOnly cookie; no credential enters app memory. */
export function createWebTransport(fetcher: typeof fetch = fetch) {
  return {
    async rpc<Input extends ZodType, Output extends ZodType>(
      contract: RpcContract<Input, Output>, input: ZodInput<Input>, settings = false,
    ): Promise<ZodOutput<Output>> {
      const entry = RPC_CATALOGUE.find(item => item.name === contract.name);
      const retryRead = entry?.mutating === false;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (settings) headers[SETTINGS_SURFACE_HEADER] = SETTINGS_SURFACE_VALUE;
      const bodyText = JSON.stringify({ method: contract.name, input: contract.input.parse(input) });
      const signal = contract.name === "queue.profile" ? AbortSignal.timeout(PROFILE_SAVE_TIMEOUT_MS) : undefined;
      while (true) {
        let response: Response;
        try {
          response = await fetcher("/api/rpc", { method: "POST", headers, body: bodyText, signal });
          if (signal) {
            // Keep the same deadline while reading the acknowledgement body.
            return await readRpcResponse(contract, response);
          }
        } catch (error) {
          if (signal?.aborted)
            throw new Error("The service did not confirm the save within 10 seconds. Check the stored profile settings.", { cause: error });
          if (!retryRead) throw error;
          await waitForService();
          continue;
        }
        if (retryRead && [502, 503, 504].includes(response.status)) { await waitForService(); continue; }
        return readRpcResponse(contract, response);
      }
    },
    events(signal: AbortSignal) {
      return fetcher("/api/events", { signal });
    },
  };
}

async function readRpcResponse<Input extends ZodType, Output extends ZodType>(
  contract: RpcContract<Input, Output>, response: Response,
): Promise<ZodOutput<Output>> {
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `Board request failed (${response.status})`);
  return contract.output.parse(body.result);
}
