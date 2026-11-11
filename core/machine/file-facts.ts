import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

/** Parsed facts survive only while the exact regular file is unchanged. Errors are never cached. */
export class FileFacts<T> {
  private readonly entries = new Map<string, { signature: string; value: T }>();
  constructor(private readonly load: (path: string) => T) {}
  private signature(path: string): string | null {
    try {
      const info = lstatSync(path, { bigint: true });
      return info.isFile() && !info.isSymbolicLink()
        ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.uid}` : null;
    } catch { return null; }
  }
  read(path: string): T {
    const key = resolve(path), signature = this.signature(key), cached = this.entries.get(key);
    if (signature !== null && cached?.signature === signature) return cached.value;
    this.entries.delete(key);
    const value = this.load(key);
    if (signature !== null && value != null && this.signature(key) === signature) {
      if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { signature, value });
    }
    return value;
  }
}
