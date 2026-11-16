import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, writeFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { LIVE_OUTPUT_BYTES, type LiveOutputLog, type LiveOutputSecret } from "../machine/live-output";
import { tokenRedactor } from "../machine/token-redactor";

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
export async function openQaLiveOutput(path: string, secret?: LiveOutputSecret): Promise<LiveOutputLog & { close(): Promise<void> } | null> {
  let file;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    file = await open(path, "a", 0o600);
  } catch { return null; }
  let pending = Buffer.alloc(0);
  let writing: Promise<void> | null = null;
  let written = 0;
  let closed = false;
  let dropped = false;
  const marker = Buffer.from("\n[queue] live output truncated; the step logs beside the run keep the full record\n");
  const drain = async () => {
    while (pending.length) {
      const bytes = pending; pending = Buffer.alloc(0);
      const truncate = dropped || written + bytes.length > LIVE_OUTPUT_BYTES;
      dropped = false;
      try {
        if (truncate) { await file.truncate(0); await file.writeFile(marker); written = marker.length; }
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
  return {
    path,
    write(chunk) { if (!closed) redactor.write(chunk); },
    async close() {
      if (closed) return;
      closed = true;
      redactor.flush();
      await writing;
      await drain();
      await file.close().catch(() => {});
    },
  };
}
