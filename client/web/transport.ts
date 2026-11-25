import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { RpcContract } from "../../shared/rpc";

/** What the shared screens call: one board RPC, parsed by its contract. */
export interface BoardTransport {
  rpc<Input extends ZodType, Output extends ZodType>(
    contract: RpcContract<Input, Output>, input: ZodInput<Input>, settings?: boolean,
  ): Promise<ZodOutput<Output>>;
}
