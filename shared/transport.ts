import { isSshAuthExhausted } from './ssh-auth';
/**
 * True when a failure is the daemon transport rather than anything about the task.
 *
 * The transport flaps: liveness timeouts and socket drops move the client between
 * connected and disconnected, and a call in flight during a drop fails. That is not a
 * task fault and must not park a lane for an operator - a lane whose wake failed during
 * a drop sat for hours while the transport had already recovered, and the daemon's error
 * text ended up being turned into a worker instruction.
 */
export function isTransportFailure(error: unknown): boolean {
  if (isSshAuthExhausted(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  // T3Code transport and timeout errors are an observation outage: the read is retried on the next sweep, never attention.
  return /Transport not connected|not connected|disconnected|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|Liveness check timed out|Daemon connection did not settle|Daemon client closed|T3Code (transport|timeout)|authenticated host connection is unavailable/i.test(message);
}
