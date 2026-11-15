export interface WriteOptions {
  exclusive?: boolean;
  syncDirectory?: "required" | "best-effort" | "none";
}
export function writeAtomicOwnedFile(path: string, payload: Buffer | string, mode?: number, options?: WriteOptions): void;
export function writeOwnedJson(path: string, value: unknown, options?: WriteOptions): void;

/** What one owner-only read found: the file, a proven absence, or a refusal with its reason. */
export type OwnedFileRead =
  | { kind: "present"; text: string }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };
export type OwnedJsonRead<T> =
  | { kind: "present"; value: T }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };
/** Read one owner-only file without following a symlink; absence and refusal stay distinct. */
export function readOwnedFile(path: string): OwnedFileRead;
/** Read one owner-only JSON record; bytes that do not decode are a refusal, never an absence. */
export function readOwnedJson<T>(path: string, parse: (value: unknown) => T): OwnedJsonRead<T>;
