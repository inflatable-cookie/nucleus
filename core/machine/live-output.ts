import { tokenRedactor } from "./token-redactor";
/**
 * The live output an operator watches while a run is still running (task 530).
 *
 * The detached supervisors keep a run's output in memory and write their step
 * logs only when a step ends, so a running test or QA run had no file to follow.
 * Each supervisor now tees every chunk into one per-run live log beside its own
 * supervision files, and the service's live-run presence follows that file in a
 * workspace terminal tab. The live log is a window on the run, never its record:
 * step logs and the result envelope stay authoritative, and the log keeps only
 * the most recent bytes of a long run.
 *
 * A log that cannot be opened or written never fails the run it observes, and a
 * run's token is redacted across chunk boundaries exactly as the host-run
 * supervisor keeps one out of its own retained output.
 */
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Bytes one live log keeps before it restarts with the most recent output. */
export const LIVE_OUTPUT_BYTES = 512 * 1024;
const TRUNCATION_MARKER =
  "\n[queue] live output truncated; the step logs beside the run keep the full record\n";

export interface LiveOutputLog {
  readonly path: string;
  write(chunk: Buffer): void;
  close(): void;
}

/**
 * The secret to keep out of the log, or a reader for it: a run's token is issued
 * lazily, right before its first step, so a log opened earlier asks for the
 * current value on every chunk instead of caching an empty one.
 */
export type LiveOutputSecret = string | (() => string | undefined);

/** Open one live log for appending, or answer null when it cannot be written at all. */
export function openLiveOutputLog(
  path: string,
  secret?: LiveOutputSecret,
): LiveOutputLog | null {
  let fd: number;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(path, "a", 0o600);
  } catch {
    return null;
  }
  let written = 0;
  let closed = false;
  const publish = (bytes: Buffer) => {
    if (!bytes.length) return;
    try {
      if (written + bytes.length > LIVE_OUTPUT_BYTES) {
        ftruncateSync(fd, 0);
        written = 0;
        const marker = Buffer.from(TRUNCATION_MARKER);
        writeSync(fd, marker);
        written += marker.length;
      }
      writeSync(fd, bytes);
      written += bytes.length;
    } catch {
      /* the terminal is a projection; losing it never fails the run */
    }
  };
  const redactor = tokenRedactor(secret, publish);
  return {
    path,
    write(chunk) {
      if (!closed && chunk.length) redactor.write(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      redactor.flush();
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}
