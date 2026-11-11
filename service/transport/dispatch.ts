/**
 * Shared catalogue dispatch (Contract 007).
 *
 * The service socket handlers and the persistence executor worker both serve
 * the same catalogue, so the validation-and-call sequence lives here once:
 * input is validated with the shared contract schema, the owner handler runs,
 * and the output is validated before it leaves. Unknown methods fail closed.
 * This module must stay free of transport imports.
 */
import { RPC_CATALOGUE } from "../../shared/rpc-catalogue";
import { capacityWriteRefusalMessage, capacityWriteSurface } from "../../shared/capacity-authority";
import { WEB_SURFACE, webSurfaceRefusal } from "../../shared/web-surface";

const catalogue = new Map(RPC_CATALOGUE.map(entry => [entry.name, entry]));

/**
 * The surface a request arrived from, as the transport derived it. `via` is set by
 * the Paseo plugin bridge and the token-checked web board, and by nothing else; a
 * direct socket client (the CLI, a task shell) sends none.
 */
export interface CatalogueCallContext { via?: string | null }

/**
 * A catalogue method that exists but is not a write route at all. The Settings-only
 * capacity rule (service-boundary contract) answers with this: a definite policy
 * answer from a healthy service, never an `internal` fault.
 */
export class CapacityWriteRefusalError extends Error {
  readonly code = "capacity-write";
  constructor(readonly method: string, message: string) { super(message); }
}

/** A served method that a particular surface refuses by policy (the web board's `task.register`). */
export class SurfaceRefusalError extends Error {
  readonly code = "surface-refused";
  constructor(readonly method: string, message: string) { super(message); }
}

/** A catalogue method name that the service does not serve. */
export class MethodNotServedError extends Error {
  constructor(name: string) { super(`Unknown method ${name}`); }
}

/** Run one catalogue method against an owner handler with contract validation. */
export async function callCatalogueMethod(owner: unknown, method: string, input: unknown, context: CatalogueCallContext = {}): Promise<unknown> {
  const entry = catalogue.get(method);
  if (!entry) throw new MethodNotServedError(method);
  let validated = await (entry.contract.input as { parseAsync?: (value: unknown) => Promise<unknown> }).parseAsync?.(input) ?? input;
  // The Settings-only capacity rule (service-boundary contract, "Settings-only
  // capacity writes"): `queue.capacity` is allowed only when the *transport* says
  // the request came through the Paseo plugin bridge or the web board with a valid
  // token, the two Settings routes. Every other surface (the documented CLI, a
  // direct socket client, a task shell, a tokenless web request, a forged
  // `authority`/`caller`/`approver` field in the body) is refused here, before any
  // handler, with the same typed answer and zero mutation. The strict input schema
  // has already run, so a body claiming an identity is refused as input first; the
  // provenance, not the body, is what this reads.
  if (entry.name === "queue.capacity" && !capacityWriteSurface(context.via))
    throw new CapacityWriteRefusalError(entry.name, capacityWriteRefusalMessage());
  if (context.via === WEB_SURFACE) {
    const refusal = webSurfaceRefusal(entry.name);
    if (refusal) throw new SurfaceRefusalError(entry.name, refusal);
  }
  const handler = (owner as unknown as Record<string, unknown>)[entry.method];
  if (typeof handler !== "function") throw new Error(`Catalogue method ${entry.name} has no owner handler`);
  const resolve = (owner as { resolveTaskReferences?: (input: unknown) => unknown }).resolveTaskReferences;
  if (resolve) validated = resolve.call(owner, validated);
  // Owner handlers keep their established `(input, accepted, context)` signature: the
  // second slot is the durable-acceptance callback (unused now that the retired request
  // seam is gone) and the transport provenance stays third, which is the position
  // `configureCapacity` and its callers read.
  const raw = await Promise.resolve((handler as (...args: unknown[]) => unknown).call(owner, validated, undefined, context));
  return await (entry.contract.output as { parseAsync?: (value: unknown) => Promise<unknown> })?.parseAsync?.(raw) ?? raw;
}

/** Validate a catalogue method's input without running its handler. */
export function parseCatalogueInput(method: string, input: unknown): unknown {
  const entry = catalogue.get(method);
  if (!entry) throw new MethodNotServedError(method);
  return (entry.contract.input as { parse?: (value: unknown) => unknown }).parse?.(input ?? {});
}

/** Validate a value against a catalogue method's output contract. */
export function parseCatalogueOutput(method: string, value: unknown): unknown {
  const entry = catalogue.get(method);
  if (!entry) throw new MethodNotServedError(method);
  return (entry.contract.output as { parse?: (value: unknown) => unknown }).parse?.(value);
}
