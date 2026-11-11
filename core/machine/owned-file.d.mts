export interface WriteOptions {
  exclusive?: boolean;
  syncDirectory?: "required" | "best-effort" | "none";
}
export function writeAtomicOwnedFile(path: string, payload: Buffer | string, mode?: number, options?: WriteOptions): void;
export function writeOwnedJson(path: string, value: unknown, options?: WriteOptions): void;
