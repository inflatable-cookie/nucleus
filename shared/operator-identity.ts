/** The service records this only after authenticating a T3 ACP binding. */
export const t3OperatorIdentity = (hostId: string): string => `operator (${hostId})`;
export const isT3OperatorIdentity = (value: string): boolean => /^operator \(t3code:[A-Za-z0-9_-]{1,180}\)$/.test(value);
/** A board or authenticated T3 operator can provide a direct operator answer. */
export const isOperatorBoardOrT3 = (value: string): boolean => value === "operator (board)" || isT3OperatorIdentity(value);
