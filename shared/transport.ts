import { isSshAuthExhausted } from './ssh-auth';
import { isConnectionLoss, isHostTransportFailure } from './service/transport.mjs';
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
  return isHostTransportFailure(error);
}

/**
 * A transport failure or a dropped connection: the shape that makes a delivered
 * effect's outcome unknown rather than refused. Kept beside `isTransportFailure`
 * so a caller decides on one predicate, never on its own message regex.
 */
export function isTransportOrConnectionLoss(error: unknown): boolean {
  if (isSshAuthExhausted(error)) return false;
  return isTransportFailure(error) || isConnectionLoss(error);
}
