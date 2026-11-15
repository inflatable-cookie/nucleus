export function callbackTransportPhase(error: unknown): 'connect' | 'inflight' | 'response' | null;
export function uncertainTransportFailure(error: unknown): boolean;
export function isConnectionLoss(error: unknown): boolean;
export function isHostTransportFailure(error: unknown): boolean;
