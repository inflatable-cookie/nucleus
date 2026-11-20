import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { LIVE_OUTPUT_BYTES, type LiveOutputLog, type LiveOutputSecret } from "../machine/live-output";
import { tokenRedactor } from "../machine/token-redactor";
import { boundedPromise } from "../machine/bounded-promise";

export const QA_LIVE_OUTPUT_DRAIN_BOUND_MS = 2_000;

/** Durable publication without blocking the supervisor's heartbeat event loop. */
export async function writeQaJsonAsync(path: string, value: unknown, options: { durable?: boolean; requireDirectorySync?: boolean } = {}): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(value));
    if (options.durable !== false) await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, path);
    if (options.durable !== false) {
      try {
        const directory = await open(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { if (options.requireDirectorySync) throw error; }
    }
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}

export async function writeQaStepLogAsync(path: string, buffer: Buffer): Promise<{ bytes: number | null; error: string | null }> {
  try {
    await writeFile(path, buffer, { mode: 0o600 });
    await chmod(path, 0o600);
    return { bytes: buffer.length, error: null };
  } catch (error) { return { bytes: null, error: error instanceof Error ? error.message : String(error) }; }
}

/** A slow terminal projection keeps only a bounded pending tail, never blocking step output. */
export async function openQaLiveOutput(
  path: string,
  secret?: LiveOutputSecret,
  options: { drainTimeoutMs?: number } = {},
): Promise<LiveOutputLog & { flush(): Promise<boolean>; close(): Promise<void> } | null> {
  let file;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    file = await open(path, "a+", 0o600);
  } catch { return null; }
  let pending = Buffer.alloc(0);
  let writing: Promise<void> | null = null;
  let written = 0;
  let closed = false;
  let dropped = false;
  const drainTimeoutMs = Math.max(0, options.drainTimeoutMs ?? QA_LIVE_OUTPUT_DRAIN_BOUND_MS);
  const marker = Buffer.from("\n[queue] live output truncated; the step logs beside the run keep the full record\n");
  const drain = async () => {
    while (pending.length) {
      let bytes = pending; pending = Buffer.alloc(0);
      const lostPending = dropped;
      const truncate = lostPending || written + bytes.length > LIVE_OUTPUT_BYTES;
      dropped = false;
      try {
        if (truncate) {
          // Preserve the most recent already-written bytes as well as this
          // chunk. In particular, a short redactor flush must not replace a
          // whole full log with just the withheld token-length tail.
          bytes = bytes.subarray(-Math.max(0, LIVE_OUTPUT_BYTES - marker.length));
          const keep = lostPending ? 0 : Math.min(written, LIVE_OUTPUT_BYTES - marker.length - bytes.length);
          const tail = Buffer.alloc(keep);
          if (keep) {
            const read = await file.read(tail, 0, keep, written - keep);
            if (read.bytesRead !== keep) throw new Error("Could not read live output tail");
          }
          await file.truncate(0);
          await file.writeFile(marker);
          if (keep) await file.writeFile(tail);
          written = marker.length + keep;
        }
        await file.writeFile(bytes);
        written += bytes.length;
      } catch { /* the terminal projection is best effort */ }
    }
  };
  const redactor = tokenRedactor(secret, bytes => {
    if (!bytes.length) return;
    if (pending.length + bytes.length > LIVE_OUTPUT_BYTES) dropped = true;
    pending = Buffer.from(Buffer.concat([pending, bytes]).subarray(-LIVE_OUTPUT_BYTES));
    if (!writing) writing = drain().finally(() => { writing = null; });
  });
  const flushPending = async (): Promise<boolean> => {
    redactor.flush();
    while (writing || pending.length) {
      if (writing) await writing;
      if (pending.length && !writing) {
        writing = drain().finally(() => { writing = null; });
        await writing;
      }
    }
    return true;
  };
  return {
    path,
    write(chunk) { if (!closed) redactor.write(chunk); },
    async flush() {
      if (closed) return true;
      return boundedPromise(flushPending(), drainTimeoutMs, () => false);
    },
    async close() {
      if (closed) return;
      closed = true;
      await boundedPromise(flushPending(), drainTimeoutMs, () => false);
      await boundedPromise(file.close().catch(() => {}), 1_000, () => undefined);
    },
  };
}
