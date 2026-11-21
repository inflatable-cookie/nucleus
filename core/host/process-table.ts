import { readHostUidProcesses } from "../machine/host-process-listing";
import type { HostProcessFact } from "./types";

/**
 * The host's uid-scoped process table, or null when the read is unknown. Host
 * adapters reach the table through the public host index; an adapter that
 * protects its own runtime marks it before a sweep reads it.
 */
export async function readHostProcessTable(): Promise<HostProcessFact[] | null> {
  const read = await readHostUidProcesses();
  return read.state === "listed" ? read.processes : null;
}
