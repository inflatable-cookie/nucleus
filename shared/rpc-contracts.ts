import { compiledIdentity } from "./runtime.mjs";
/** Stable wire-contract identities for the catalogued Queue RPC methods. */
import { createHash } from "node:crypto";
import { RPC_CATALOGUE } from "./rpc-catalogue";

type ZodContractSchema = { _zod?: { def?: unknown; bag?: unknown } };

function contractShape(value: unknown, parents = new Set<object>()): unknown {
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "symbol") return ["symbol", String(value.description ?? "")];
  if (typeof value === "function") return ["function", Function.prototype.toString.call(value)];
  if (typeof value !== "object") return String(value);
  if (value instanceof RegExp) return ["regexp", value.source, value.flags];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (parents.has(value)) return ["circular"];

  parents.add(value);
  let shape: unknown;
  if (Array.isArray(value)) {
    shape = value.map(item => contractShape(item, parents));
  } else if (value instanceof Map) {
    shape = [...value.entries()]
      .map(([key, item]) => [contractShape(key, parents), contractShape(item, parents)])
      .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
  } else if (value instanceof Set) {
    shape = [...value].map(item => contractShape(item, parents)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  } else {
    const schema = value as ZodContractSchema;
    const def = schema._zod?.def;
    if (def !== undefined) {
      shape = ["zod", contractShape(def, parents), contractShape(schema._zod?.bag ?? {}, parents)];
    } else {
      const record = value as Record<string, unknown>;
      shape = Object.fromEntries(Object.keys(record).sort().map(key => [key, contractShape(record[key], parents)]));
    }
  }
  parents.delete(value);
  return shape;
}

function schemaShape(schema: unknown, method: string, direction: string): unknown {
  if (typeof schema !== "object" || schema === null || !("_zod" in schema)) {
    throw new Error(`RPC ${method} has no Zod ${direction} contract`);
  }
  return contractShape(schema);
}

/** A method digest covers its input and output Zod contracts, including checks and transforms. */
export function contractDigest(contract: { input: unknown; output: unknown }, method = "contract"): string {
  const input = schemaShape(contract.input, method, "input");
  const output = schemaShape(contract.output, method, "output");
  return createHash("sha256").update(JSON.stringify(["rpc-contract-v1", input, output])).digest("hex");
}

/** A method digest covers its input and output Zod contracts, including checks and transforms. */
export function rpcContractDigest(method: string): string | null {
  if (compiledIdentity) return compiledIdentity.rpcContracts[method] ?? null;
  const entry = RPC_CATALOGUE.find(candidate => candidate.name === method);
  if (!entry) return null;
  return contractDigest(entry.contract, method);
}

/** The service publishes one digest for every currently catalogued method. */
export function rpcContractDigests(): Record<string, string> {
  return Object.fromEntries(RPC_CATALOGUE.map(entry => [entry.name, rpcContractDigest(entry.name)!]));
}
