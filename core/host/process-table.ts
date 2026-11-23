import { readHostUidProcesses } from "../machine/host-process-listing";
import type { HostProcessTable } from "./types";

/**
 * The host's uid-scoped process table. An unknown read rejects with its named
 * reason ("the open-file listing timed out after 12000 ms"), so the caller
 * reports that reason and never a bare null. Host adapters reach the table
 * through the public host index; an adapter that protects its own runtime marks
 * it before a sweep reads it.
 */
export async function readHostProcessTable(): Promise<HostProcessTable | null> {
  const read = await readHostUidProcesses();
  if (read.state === "unknown") throw new Error(read.reason);
  return Object.assign(read.processes, { cwdComplete: read.cwdComplete });
}
