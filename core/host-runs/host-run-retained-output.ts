import { closeSync, constants, fsyncSync, writeSync } from "node:fs";
import { hostRunSupervisorPaths, openVerifiedOwnedFile } from "./host-run-files";
import { streamTruncationMarker, type StreamTruncation } from "../machine/output-retention";
import { tokenRedactor } from "../machine/token-redactor";

/**
 * One run's retained output files (`runs/<id>/stdout`, `runs/<id>/stderr`).
 *
 * The files are the contract-010 record `attach` resumes from, so they are
 * appended as the command produces output, and the run's token is redacted
 * across chunk boundaries. Each stream is capped: output is unbounded work on a
 * shared disk, and a capped stream says so in its own bytes instead of reading
 * as the whole of the command's output. The marker names what was observed,
 * kept and omitted and where the cap was.
 */
export interface HostRunRetainedOutput {
  /** Append one chunk to the named stream. */
  write(stream: "stdout" | "stderr", chunk: Buffer): void;
  /** Flush, fsync and close both files, marking any stream the cap truncated. */
  close(): void;
  /** What each stream kept, or null when the cap cut nothing. */
  truncation(): { stdout: StreamTruncation | null; stderr: StreamTruncation | null };
}

interface RetainedStreamState {
  written: number;
  observed: number;
  capped: boolean;
}

function appendStream(stateDir: string, parts: string[]): number {
  return openVerifiedOwnedFile(stateDir, parts, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
}

export function openHostRunRetainedOutput(
  stateDir: string,
  runId: string,
  capBytes: number,
  secret: string | undefined,
): HostRunRetainedOutput {
  const paths = hostRunSupervisorPaths(stateDir, runId);
  const files = {
    stdout: { fd: appendStream(stateDir, ["runs", runId, "stdout"]), state: { written: 0, observed: 0, capped: false } as RetainedStreamState },
    stderr: { fd: appendStream(stateDir, ["runs", runId, "stderr"]), state: { written: 0, observed: 0, capped: false } as RetainedStreamState },
  };
  let closed = false;
  const sinks = {
    stdout: tokenRedactor(secret, bytes => publish("stdout", bytes)),
    stderr: tokenRedactor(secret, bytes => publish("stderr", bytes)),
  };
  const publish = (stream: "stdout" | "stderr", bytes: Buffer) => {
    if (!bytes.length) return;
    const { fd, state } = files[stream];
    state.observed += bytes.length;
    const room = Math.max(0, capBytes - state.written);
    if (bytes.length <= room) {
      writeSync(fd, bytes);
      state.written += bytes.length;
      return;
    }
    if (room > 0) {
      writeSync(fd, bytes.subarray(0, room));
      state.written += room;
    }
    state.capped = true;
  };
  const truncationOf = (state: RetainedStreamState): StreamTruncation | null =>
    state.capped ? { observedBytes: state.observed, omittedBytes: Math.max(0, state.observed - state.written) } : null;
  return {
    write(stream, chunk) {
      if (closed || !chunk.length) return;
      sinks[stream].write(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const stream of ["stdout", "stderr"] as const) {
        const { fd, state } = files[stream];
        try { sinks[stream].flush(); } catch { /* output loss never fails a run */ }
        const truncation = truncationOf(state);
        if (truncation) {
          try { writeSync(fd, Buffer.from(`${streamTruncationMarker(truncation, capBytes, "beginning kept")}\n`)); } catch { /* the cap still held */ }
        }
        try { fsyncSync(fd); } catch { /* closed */ }
        try { closeSync(fd); } catch { /* closed */ }
      }
    },
    truncation() {
      return { stdout: truncationOf(files.stdout.state), stderr: truncationOf(files.stderr.state) };
    },
  };
}
