/**
 * One refused host-run request, carrying the contract-010 client error code it
 * answers with.
 *
 * The scheduler, admission, accounting and settlement owners each refuse a
 * request at a named boundary. The code is a typed field on the refusal, so the
 * contract-010 endpoint answers with the code that was decided where the rule
 * lives and never re-derives it from the refusal's words. The rendering keeps
 * the `code: detail` shape every refusal text and recorded diagnostic already
 * had, so a journal entry still reads the same.
 */
import type { HostRunClientErrorCode } from "./host-run-endpoint-types";

export class HostRunRefusal extends Error {
  constructor(readonly code: HostRunClientErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "HostRunRefusal";
  }
}

/** Refuse one host-run request with the code the contract-010 client receives. */
export function refuseHostRun(code: HostRunClientErrorCode, detail: string): never {
  throw new HostRunRefusal(code, detail);
}

/** The refusal behind one thrown error, or null when it is not a coded refusal. */
export function hostRunRefusal(error: unknown): HostRunRefusal | null {
  return error instanceof HostRunRefusal ? error : null;
}
