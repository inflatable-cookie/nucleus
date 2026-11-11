import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { RpcContract } from "../../shared/rpc";
import { SETTINGS_SURFACE_HEADER, SETTINGS_SURFACE_VALUE } from "../../shared/web-surface";

/** A board session keeps its bearer token only in this closure. */
export function createWebTransport(token: string, fetcher: typeof fetch = fetch) {
  return {
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
