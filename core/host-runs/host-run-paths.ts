/**
 * Contract 010's socket names inside the host-run state root (Spec 035). The
 * public contract path and the front worker's private inner path are named
 * here, apart from the endpoint and from that worker, so both owners agree on
 * one spelling without importing each other.
 *
 * - `run/scheduler.sock` is the contract-010 discovery socket clients connect
 *   to. It is the only name the protocol publishes.
 * - `run/scheduler.sock.staged` is the make-before-break bind name that is
 *   renamed onto the live path (libuv then unlinks the staged name on close).
 * - `run/inner-<pid>-<token>.sock` is the runtime's private socket. It never
 *   appears in `authority.json` and is not part of the client-visible contract:
 *   only the front worker of the same process connects to it.
 */
import { join } from "node:path";

export const HOST_RUN_SOCKET_LEAF = "scheduler.sock";
export const HOST_RUN_STAGED_SOCKET_LEAF = "scheduler.sock.staged";
/** Queue-owned Effigy admission hook socket; not part of contract 010. */
export const HOST_RUN_ADMISSION_SOCKET_LEAF = "admission.sock";
const INNER_SOCKET_LEAF = /^inner-(\d+)-[0-9a-f]+\.sock$/;

export const hostRunSocketPath = (stateDir: string) => join(stateDir, "run", HOST_RUN_SOCKET_LEAF);
export const hostRunStagedSocketPath = (stateDir: string) => join(stateDir, "run", HOST_RUN_STAGED_SOCKET_LEAF);
export const hostRunAdmissionSocketPath = (stateDir: string) => join(stateDir, "run", HOST_RUN_ADMISSION_SOCKET_LEAF);
export const hostRunInnerSocketPath = (stateDir: string, token: string) => join(stateDir, "run", `inner-${token}.sock`);

/** True for a leaf this module minted for a private runtime socket. */
export function isHostRunInnerSocketLeaf(leaf: string): boolean {
  return INNER_SOCKET_LEAF.test(leaf);
}

/** The pid a private runtime socket belongs to, or null for any other leaf. */
export function hostRunInnerSocketOwnerPid(leaf: string): number | null {
  const match = INNER_SOCKET_LEAF.exec(leaf);
  return match ? Number(match[1]) : null;
}
