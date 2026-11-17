import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { RpcContract } from "../../shared/rpc";
import { SETTINGS_SURFACE_HEADER, SETTINGS_SURFACE_VALUE } from "../../shared/web-surface";

/** Schedule renewal one minute before expiry; callers replace their transport after success. */
export function scheduleWebTokenRenewal(expiresAt: number, renew: () => void, now = Date.now): ReturnType<typeof setTimeout> {
  return setTimeout(renew, Math.max(0, expiresAt - now() - 60_000));
}

/** A board session keeps its bearer token only in this closure. */
export function createWebTransport(token: string, fetcher: typeof fetch = fetch) {
  async function renew(): Promise<{ token: string; expiresAt: number }> {
    const response = await fetcher("/api/renew", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json() as { token?: unknown; expiresAt?: unknown; error?: { message?: string } };
    if (!response.ok || typeof body.token !== "string" || typeof body.expiresAt !== "number")
      throw new Error(body.error?.message ?? `Board token renewal failed (${response.status})`);
    return { token: body.token, expiresAt: body.expiresAt };
  }
  return {
    renew,
    async rpc<Input extends ZodType, Output extends ZodType>(
      contract: RpcContract<Input, Output>, input: ZodInput<Input>, settings = false,
    ): Promise<ZodOutput<Output>> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      if (settings) headers[SETTINGS_SURFACE_HEADER] = SETTINGS_SURFACE_VALUE;
      const response = await fetcher("/api/rpc", {
        method: "POST", headers, body: JSON.stringify({ method: contract.name, input: contract.input.parse(input) }),
      });
      const body = await response.json() as { result?: unknown; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? `Board request failed (${response.status})`);
      return contract.output.parse(body.result);
    },
    events(signal: AbortSignal) {
      return fetcher("/api/events", { headers: { authorization: `Bearer ${token}` }, signal });
    },
  };
}
