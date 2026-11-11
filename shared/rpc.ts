import type { ZodType } from "zod";

/**
 * One board RPC: a name the server registers and the input and output schemas
 * both sides validate against. The same shape the plugin host reads, so a
 * contract passes to any shell's `useRpc` unchanged.
 */
export interface RpcContract<Input extends ZodType = ZodType, Output extends ZodType = ZodType> {
  name: string;
  input: Input;
  output: Output;
}

/** Names one RPC. Identity at runtime; it keeps shared code free of any host package. */
export function defineRpc<Input extends ZodType, Output extends ZodType>(definition: RpcContract<Input, Output>): RpcContract<Input, Output> {
  return definition;
}
