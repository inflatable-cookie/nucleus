/** Transport error facts shared by callback and catalogue clients. */
const CONNECT_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES', 'ELOOP', 'ENAMETOOLONG']);

function errorCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Callback delivery phase, or null when the failure is a Queue answer or non-transport fault. */
export function callbackTransportPhase(error) {
  if (error instanceof Error && typeof error.callbackStatus === 'number') return null;
  const code = errorCode(error);
  const message = errorMessage(error);
  const transport = CONNECT_CODES.has(code)
    || /ENOENT|ECONNREFUSED|ENOTSOCK|EACCES|ELOOP|ENAMETOOLONG|ECONNRESET|EPIPE|socket hang up|aborted|no such file|not connected|disconnected/i.test(message);
  if (!transport) return null;
  if (CONNECT_CODES.has(code) || /connect (?:ENOENT|ECONNREFUSED|ENOTSOCK|EACCES|ELOOP|ENAMETOOLONG)|no such file/i.test(message)) return 'connect';
  return error?.transportPhase === 'response' ? 'response' : 'inflight';
}

/** Catalogue mutation delivery can be retried only after its receipt is confirmed. */
export function uncertainTransportFailure(error) {
  if (error && error.name === 'ServiceRequestError') {
    if (error.code === 'draining' || error.code === 'unavailable') return true;
    return error.code === 'timeout' && /timed out after/.test(error.message);
  }
  const message = errorMessage(error);
  return /Service socket closed|ECONNRESET|EPIPE|socket hang up|Connection reset|Connection closed/i.test(message);
}

export function isConnectionLoss(error) {
  return /\bconnection (?:lost|reset)\b/i.test(errorMessage(error));
}

/** Broad host transport outage used by lifecycle recovery, excluding ambiguous connection prose. */
export function isHostTransportFailure(error) {
  const code = errorCode(error);
  const message = errorMessage(error);
  return CONNECT_CODES.has(code) || /\bTransport not connected\b|\bdisconnected\b|ECONNRESET|EPIPE|socket hang up|Liveness check timed out|Daemon connection did not settle|Daemon client closed|T3Code (?:transport|timeout)|authenticated host connection is unavailable/i.test(message);
}
