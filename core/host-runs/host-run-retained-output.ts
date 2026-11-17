import { createHash, type Hash } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { hostRunSupervisorPaths, openVerifiedOwnedFile } from "./host-run-files";
import { streamTruncationMarker, type StreamTruncation } from "../machine/output-retention";
import { tokenRedactor } from "../machine/token-redactor";

/**
 * One run's retained output.
 *
 * The ordinary capture keeps `runs/<id>/stdout` and `runs/<id>/stderr`: the
 * contract-010 record `attach` resumes from, appended as the command produces
 * output, with the run's token redacted across chunk boundaries. Each stream is
 * capped, because output is unbounded work on a shared disk, and a capped stream
 * says so in its own bytes instead of reading as the whole of the command's
 * output.
 *
 * Spec 064 P4 adds the qualification capture: **one** combined
 * `runs/<id>/qualification.raw` file, no per-stream files, no cap, no redaction,
 * no second copy. It is opt-in per open, so with the mode absent both files and
 * the 8 MiB cap are exactly what they were.
 */
export interface HostRunRetainedOutput {
  /** Which files this capture owns. */
  readonly mode: HostRunRetainedOutputMode;
  /** Append one chunk to the named stream. */
  write(stream: HostRunRetainedOutputStream, chunk: Buffer): void;
  /**
   * Spec 064 P4: the named stream's real pipe EOF. The qualification capture
   * writes exactly one EOF frame here, at that stream's final offset. The
   * ordinary capture has no framed markers, so this is a no-op for it.
   */
  markEof(stream: HostRunRetainedOutputStream): void;
  /**
   * Spec 064 P4: every observed payload write for that stream completed after
   * its EOF. The qualification capture writes exactly one DRAIN frame here.
   */
  markDrained(stream: HostRunRetainedOutputStream): void;
  /**
   * Flush, fsync and close. The ordinary capture marks any stream the cap
   * truncated; the qualification capture syncs and closes its one artifact and
   * reports its evidence and every fault it observed.
   */
  close(): HostRunRetainedOutputClose;
  /** What each ordinary stream kept, or null when the cap cut nothing. */
  truncation(): { stdout: StreamTruncation | null; stderr: StreamTruncation | null };
}

export type HostRunRetainedOutputMode = "streams" | "qualification";
export type HostRunRetainedOutputStream = "stdout" | "stderr";

/** What one `close()` established. */
export interface HostRunRetainedOutputClose {
  /** P4's combined artifact evidence, or null when this run kept the two ordinary streams. */
  qualification: QualificationRawEvidence | null;
  /**
   * Every fault the qualification capture observed, in order. The ordinary
   * capture keeps its documented resilience (output loss never fails a run), so
   * it reports none.
   */
  faults: QualificationCaptureFault[];
}

// ---------------------------------------------------------------------------
// Spec 064 P4: the NQRAW001 combined raw artifact
// ---------------------------------------------------------------------------

/**
 * The artifact's whole shape, literally P4's: eight ASCII magic bytes, then
 * 22-byte big-endian frames. DATA carries 1–65,536 payload bytes; EOF and DRAIN
 * carry none. Sequence is global and gap-free from 1; offset is that stream's
 * payload bytes before the frame. One EOF frame per stream on its real pipe EOF,
 * then one DRAIN frame at the same final offset. With B payload bytes and N DATA
 * frames the complete file is `8 + B + 22 x (N + 4)` bytes.
 */
export type QualificationRawStream = "stdout" | "stderr";
export type QualificationRawKind = "DATA" | "EOF" | "DRAIN";
export const QUALIFICATION_RAW_MAGIC = "NQRAW001";
export const QUALIFICATION_RAW_HEADER_BYTES = 22;
export const QUALIFICATION_RAW_MAX_DATA_BYTES = 65_536;
export const QUALIFICATION_RAW_STREAMS: readonly QualificationRawStream[] = ["stdout", "stderr"];
const RAW_KIND_CODE: Record<QualificationRawKind, number> = { DATA: 1, EOF: 2, DRAIN: 3 };
const RAW_STREAM_CODE: Record<QualificationRawStream, number> = { stdout: 1, stderr: 2 };

function rawKindOf(code: number): QualificationRawKind | null {
  if (code === RAW_KIND_CODE.DATA) return "DATA";
  if (code === RAW_KIND_CODE.EOF) return "EOF";
  if (code === RAW_KIND_CODE.DRAIN) return "DRAIN";
  return null;
}

function rawStreamOf(code: number): QualificationRawStream | null {
  if (code === RAW_STREAM_CODE.stdout) return "stdout";
  if (code === RAW_STREAM_CODE.stderr) return "stderr";
  return null;
}

function encodeRawHeader(kind: QualificationRawKind, stream: QualificationRawStream, sequence: bigint, offset: bigint, length: number): Buffer {
  const header = Buffer.alloc(QUALIFICATION_RAW_HEADER_BYTES);
  header.writeUInt8(RAW_KIND_CODE[kind], 0);
  header.writeUInt8(RAW_STREAM_CODE[stream], 1);
  header.writeBigUInt64BE(sequence, 2);
  header.writeBigUInt64BE(offset, 10);
  header.writeUInt32BE(length, 18);
  return header;
}

export type QualificationRawValidationCode =
  | "short-artifact"
  | "bad-magic"
  | "partial-header"
  | "unknown-kind"
  | "unknown-stream"
  | "sequence-gap"
  | "offset"
  | "length"
  | "data-after-eof"
  | "drain-before-eof"
  | "duplicate-marker"
  | "trailing-frame"
  | "missing-marker"
  | "payload-truncated";

export class QualificationRawValidationError extends Error {
  constructor(readonly code: QualificationRawValidationCode, detail: string) {
    super(`qualification.raw is invalid (${code}): ${detail}`);
    this.name = "QualificationRawValidationError";
  }
}

function invalid(code: QualificationRawValidationCode, detail: string): never {
  throw new QualificationRawValidationError(code, detail);
}

/** One decoded frame's header. Payload bytes are the `length` bytes that follow it. */
export interface QualificationRawFrame {
  kind: QualificationRawKind;
  stream: QualificationRawStream;
  sequence: number;
  offset: number;
  length: number;
}

export interface QualificationRawStreamSummary {
  payloadBytes: number;
  /** `sha256:<hex>` over this stream's DATA payload bytes, in order. */
  payloadSha256: string;
  dataFrames: number;
  eofSequence: number | null;
  drainSequence: number | null;
}

export interface QualificationRawSummary {
  bytes: number;
  frameCount: number;
  dataFrameCount: number;
  payloadBytes: number;
  /** `sha256:<hex>` over the complete artifact, magic and framing included. */
  artifactSha256: string;
  streams: Record<QualificationRawStream, QualificationRawStreamSummary>;
}

export interface QualificationRawDecode {
  frames: QualificationRawFrame[];
  summary: QualificationRawSummary;
  /** Present only when asked for: a decode never keeps a second full log by accident. */
  payloads?: Record<QualificationRawStream, Buffer>;
}

/**
 * Strictly decode one `qualification.raw` artifact. Every rule P4 names is a
 * rejection: an unknown kind or stream, a sequence gap, a wrong offset or
 * length, a duplicate or missing terminal marker, a partial header or payload,
 * and no trailing bytes that are not complete valid frames. Payloads stay
 * uncompressed and unredacted; the caller that asks for them owns the copy.
 */
export function decodeQualificationRaw(bytes: Buffer, options: { collectPayloads?: boolean } = {}): QualificationRawDecode {
  const magic = Buffer.from(QUALIFICATION_RAW_MAGIC, "ascii");
  if (bytes.length < magic.length) invalid("short-artifact", `${bytes.length} bytes cannot hold the ${magic.length}-byte magic`);
  if (!bytes.subarray(0, magic.length).equals(magic)) invalid("bad-magic", `the artifact does not start with ${QUALIFICATION_RAW_MAGIC}`);
  const frames: QualificationRawFrame[] = [];
  const offsets: Record<QualificationRawStream, bigint> = { stdout: 0n, stderr: 0n };
  const phases: Record<QualificationRawStream, 0 | 1 | 2> = { stdout: 0, stderr: 0 };
  const streamHashes: Record<QualificationRawStream, Hash> = { stdout: createHash("sha256"), stderr: createHash("sha256") };
  const payloadBytes: Record<QualificationRawStream, number> = { stdout: 0, stderr: 0 };
  const dataFrames: Record<QualificationRawStream, number> = { stdout: 0, stderr: 0 };
  const eofSequences: Record<QualificationRawStream, number | null> = { stdout: null, stderr: null };
  const drainSequences: Record<QualificationRawStream, number | null> = { stdout: null, stderr: null };
  const collected = options.collectPayloads ? { stdout: [] as Buffer[], stderr: [] as Buffer[] } : null;
  let cursor = magic.length;
  let dataFrameCount = 0;
  while (cursor < bytes.length) {
    if (bytes.length - cursor < QUALIFICATION_RAW_HEADER_BYTES)
      invalid("partial-header", `${bytes.length - cursor} trailing bytes are not a complete header`);
    const kind = rawKindOf(bytes.readUInt8(cursor));
    if (!kind) invalid("unknown-kind", `frame ${frames.length + 1} has kind code ${bytes.readUInt8(cursor)}`);
    const stream = rawStreamOf(bytes.readUInt8(cursor + 1));
    if (!stream) invalid("unknown-stream", `frame ${frames.length + 1} has stream code ${bytes.readUInt8(cursor + 1)}`);
    const sequence = bytes.readBigUInt64BE(cursor + 2);
    if (sequence !== BigInt(frames.length + 1))
      invalid("sequence-gap", `frame ${frames.length + 1} carries sequence ${sequence}`);
    const offset = bytes.readBigUInt64BE(cursor + 10);
    if (offset !== offsets[stream])
      invalid("offset", `the ${stream} frame at sequence ${sequence} carries offset ${offset}, not ${offsets[stream]}`);
    const length = bytes.readUInt32BE(cursor + 18);
    if (kind === "DATA") {
      if (length < 1 || length > QUALIFICATION_RAW_MAX_DATA_BYTES)
        invalid("length", `a DATA frame declares ${length} bytes`);
    } else if (length !== 0) invalid("length", `a ${kind} frame declares ${length} payload bytes`);
    const phase = phases[stream];
    if (kind === "DATA" && phase === 1) invalid("data-after-eof", `the ${stream} stream has DATA after its EOF`);
    if (kind === "DATA" && phase === 2) invalid("trailing-frame", `the ${stream} stream has DATA after its DRAIN`);
    if (kind === "EOF" && phase === 1) invalid("duplicate-marker", `the ${stream} stream has a second EOF`);
    if (kind === "EOF" && phase === 2) invalid("trailing-frame", `the ${stream} stream has an EOF after its DRAIN`);
    if (kind === "DRAIN" && phase === 0) invalid("drain-before-eof", `the ${stream} stream drains before its EOF`);
    if (kind === "DRAIN" && phase === 2) invalid("duplicate-marker", `the ${stream} stream has a second DRAIN`);
    const payloadStart = cursor + QUALIFICATION_RAW_HEADER_BYTES;
    if (kind === "DATA") {
      if (bytes.length - payloadStart < length)
        invalid("payload-truncated", `a DATA frame declares ${length} bytes but ${bytes.length - payloadStart} remain`);
      const payload = bytes.subarray(payloadStart, payloadStart + length);
      streamHashes[stream].update(payload);
      if (collected) collected[stream].push(payload);
      payloadBytes[stream] += length;
      dataFrames[stream] += 1;
      dataFrameCount += 1;
      offsets[stream] += BigInt(length);
      cursor = payloadStart + length;
    } else {
      if (kind === "EOF") { eofSequences[stream] = Number(sequence); phases[stream] = 1; }
      else { drainSequences[stream] = Number(sequence); phases[stream] = 2; }
      cursor = payloadStart;
    }
    frames.push({ kind, stream, sequence: Number(sequence), offset: Number(offset), length });
  }
  for (const stream of QUALIFICATION_RAW_STREAMS) {
    if (phases[stream] === 0) invalid("missing-marker", `the ${stream} stream has no EOF frame`);
    if (phases[stream] === 1) invalid("missing-marker", `the ${stream} stream has no DRAIN frame after its EOF`);
  }
  const summary: QualificationRawSummary = {
    bytes: bytes.length, frameCount: frames.length, dataFrameCount,
    payloadBytes: payloadBytes.stdout + payloadBytes.stderr,
    artifactSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    streams: {
      stdout: {
        payloadBytes: payloadBytes.stdout, payloadSha256: `sha256:${streamHashes.stdout.digest("hex")}`,
        dataFrames: dataFrames.stdout, eofSequence: eofSequences.stdout, drainSequence: drainSequences.stdout,
      },
      stderr: {
        payloadBytes: payloadBytes.stderr, payloadSha256: `sha256:${streamHashes.stderr.digest("hex")}`,
        dataFrames: dataFrames.stderr, eofSequence: eofSequences.stderr, drainSequence: drainSequences.stderr,
      },
    },
  };
  return {
    frames, summary,
    ...(collected ? { payloads: { stdout: Buffer.concat(collected.stdout), stderr: Buffer.concat(collected.stderr) } } : {}),
  };
}

export type QualificationCaptureFaultKind = "write" | "marker" | "fsync" | "close" | "directory";

/** One thing the qualification capture could not prove. It is reported, never swallowed. */
export interface QualificationCaptureFault {
  kind: QualificationCaptureFaultKind;
  /** The stream the fault belongs to, or null for the artifact as a whole. */
  stream: QualificationRawStream | null;
  detail: string;
  at: string;
}

export interface QualificationRawStreamEvidence {
  stream: QualificationRawStream;
  payloadBytes: number;
  payloadSha256: string;
  dataFrames: number;
  eofSequence: number | null;
  drainSequence: number | null;
}

/** What the one artifact holds, exactly as the writer observed it. */
export interface QualificationRawEvidence {
  path: string;
  /** Encoded bytes actually written. */
  bytes: number;
  frameCount: number;
  dataFrameCount: number;
  artifactSha256: string;
  streams: Record<QualificationRawStream, QualificationRawStreamEvidence>;
  /** P4's size identity: `8 + B + 22 x (N + 4)`. */
  expectedBytes: number;
  sizeIdentityHolds: boolean;
  /** True when a fault stopped this artifact; its hashes then cover only a prefix. */
  latched: boolean;
}

/**
 * Fault seams, named like the verified writer's traversal hooks: each is called
 * at the exact point a real fault would be observed, so a test can prove the
 * latch, the stop and the retained partial artifact without pretending a disk
 * failed.
 */
export interface QualificationCaptureHooks {
  beforeWrite?: (stream: QualificationRawStream, frameBytes: number) => void;
  beforeFsync?: () => void;
  beforeClose?: () => void;
  beforeDirectorySync?: () => void;
}

function faultText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** fsync one directory so a new entry is durably visible, or throw the fault. */
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The one writer of one `qualification.raw`: synchronous short-write loops, one
 * payload frame at a time and no queue. Sequence, offsets, payload counts and the
 * artifact and per-stream hashes are computed incrementally as the frames land.
 * A fault latches: the artifact stops advancing and is retained as it stands.
 */
class QualificationRawCapture {
  private sequence = 0n;
  private readonly offsets: Record<QualificationRawStream, bigint> = { stdout: 0n, stderr: 0n };
  private readonly payloadBytes: Record<QualificationRawStream, number> = { stdout: 0, stderr: 0 };
  private readonly dataFrames: Record<QualificationRawStream, number> = { stdout: 0, stderr: 0 };
  private readonly streamHashes: Record<QualificationRawStream, Hash> = {
    stdout: createHash("sha256"), stderr: createHash("sha256"),
  };
  private readonly artifactHash = createHash("sha256");
  private readonly phases: Record<QualificationRawStream, 0 | 1 | 2> = { stdout: 0, stderr: 0 };
  private readonly eofSequences: Record<QualificationRawStream, number | null> = { stdout: null, stderr: null };
  private readonly drainSequences: Record<QualificationRawStream, number | null> = { stdout: null, stderr: null };
  private bytes = QUALIFICATION_RAW_MAGIC.length;
  private frameCount = 0;
  private dataFrameCount = 0;
  private readonly faults: QualificationCaptureFault[] = [];
  private closed = false;
  private result: HostRunRetainedOutputClose | null = null;

  constructor(private readonly path: string, private readonly fd: number, private readonly hooks: QualificationCaptureHooks) {
    const magic = Buffer.from(QUALIFICATION_RAW_MAGIC, "ascii");
    try { this.writeAll(magic); this.artifactHash.update(magic); }
    catch (error) { this.latch("write", null, `the artifact magic could not be written: ${faultText(error)}`); throw error; }
  }

  private get latched(): boolean {
    return this.faults.length > 0;
  }

  /** Record one fault. Every fault is kept; only the first stops the artifact. */
  private latch(kind: QualificationCaptureFaultKind, stream: QualificationRawStream | null, detail: string): Error {
    const fault: QualificationCaptureFault = { kind, stream, detail, at: new Date().toISOString() };
    this.faults.push(fault);
    return new Error(`qualification.raw capture fault (${kind}): ${detail}`);
  }

  /** Finish every byte of one frame before the next starts; a short write loops. */
  private writeAll(buffer: Buffer): void {
    let written = 0;
    while (written < buffer.length) written += writeSync(this.fd, buffer, written, buffer.length - written);
  }

  private appendFrame(kind: QualificationRawKind, stream: QualificationRawStream, payload: Buffer | null): void {
    const length = payload?.length ?? 0;
    const sequence = this.sequence + 1n;
    const offset = this.offsets[stream];
    const header = encodeRawHeader(kind, stream, sequence, offset, length);
    this.hooks.beforeWrite?.(stream, header.length + length);
    this.writeAll(header);
    if (payload) this.writeAll(payload);
    // Counters and hashes advance only once the whole frame is on disk.
    this.artifactHash.update(header);
    if (payload) {
      this.artifactHash.update(payload);
      this.streamHashes[stream].update(payload);
    }
    this.sequence = sequence;
    this.frameCount += 1;
    this.bytes += header.length + length;
    if (kind === "DATA") {
      this.dataFrameCount += 1;
      this.dataFrames[stream] += 1;
      this.payloadBytes[stream] += length;
      this.offsets[stream] += BigInt(length);
      return;
    }
    if (kind === "EOF") {
      this.eofSequences[stream] = Number(sequence);
      this.phases[stream] = 1;
      return;
    }
    this.drainSequences[stream] = Number(sequence);
    this.phases[stream] = 2;
  }

  write(stream: QualificationRawStream, chunk: Buffer): void {
    if (this.closed) throw new Error("The qualification artifact is closed; no bytes can be appended");
    if (this.latched) return;
    if (!chunk.length) return;
    for (let start = 0; start < chunk.length; start += QUALIFICATION_RAW_MAX_DATA_BYTES) {
      const payload = chunk.subarray(start, Math.min(chunk.length, start + QUALIFICATION_RAW_MAX_DATA_BYTES));
      try { this.appendFrame("DATA", stream, payload); }
      catch (error) { throw this.latch("write", stream, `the ${stream} DATA frame could not be written: ${faultText(error)}`); }
    }
  }

  markEof(stream: QualificationRawStream): void {
    if (this.closed || this.latched) return;
    if (this.phases[stream] !== 0) throw this.latch("marker", stream, `the ${stream} stream already has its EOF`);
    try { this.appendFrame("EOF", stream, null); }
    catch (error) { throw this.latch("write", stream, `the ${stream} EOF frame could not be written: ${faultText(error)}`); }
  }

  markDrained(stream: QualificationRawStream): void {
    if (this.closed || this.latched) return;
    if (this.phases[stream] !== 1) throw this.latch("marker", stream, `the ${stream} stream drained without its EOF`);
    try { this.appendFrame("DRAIN", stream, null); }
    catch (error) { throw this.latch("write", stream, `the ${stream} DRAIN frame could not be written: ${faultText(error)}`); }
  }

  close(): HostRunRetainedOutputClose {
    if (this.result) return this.result;
    this.closed = true;
    // Closing before both streams drained is an unmet obligation, not a quiet
    // truncation: the missing frames are exactly what the validator rejects.
    if (!this.latched && (this.phases.stdout !== 2 || this.phases.stderr !== 2)) {
      const missing = QUALIFICATION_RAW_STREAMS.filter(stream => this.phases[stream] !== 2);
      this.latch("marker", null, `the artifact closed before ${missing.join(" and ")} reached EOF and DRAIN`);
    }
    try { this.hooks.beforeFsync?.(); fsyncSync(this.fd); }
    catch (error) { this.latch("fsync", null, `the artifact could not be synced: ${faultText(error)}`); }
    try { this.hooks.beforeClose?.(); closeSync(this.fd); }
    catch (error) { this.latch("close", null, `the artifact could not be closed: ${faultText(error)}`); }
    try { this.hooks.beforeDirectorySync?.(); syncDirectory(dirname(this.path)); }
    catch (error) { this.latch("directory", null, `the artifact's directory could not be synced: ${faultText(error)}`); }
    this.result = { qualification: this.evidence(), faults: [...this.faults] };
    return this.result;
  }

  private evidence(): QualificationRawEvidence {
    const expectedBytes = 8 + this.payloadBytes.stdout + this.payloadBytes.stderr
      + QUALIFICATION_RAW_HEADER_BYTES * (this.dataFrameCount + 4);
    const streamEvidence = (stream: QualificationRawStream): QualificationRawStreamEvidence => ({
      stream, payloadBytes: this.payloadBytes[stream], payloadSha256: `sha256:${this.streamHashes[stream].digest("hex")}`,
      dataFrames: this.dataFrames[stream], eofSequence: this.eofSequences[stream], drainSequence: this.drainSequences[stream],
    });
    return {
      path: this.path, bytes: this.bytes, frameCount: this.frameCount, dataFrameCount: this.dataFrameCount,
      artifactSha256: `sha256:${this.artifactHash.digest("hex")}`,
      streams: { stdout: streamEvidence("stdout"), stderr: streamEvidence("stderr") },
      expectedBytes, sizeIdentityHolds: !this.latched && this.bytes === expectedBytes, latched: this.latched,
    };
  }
}

export interface OpenHostRunRetainedOutputOptions {
  /**
   * Spec 064 P4: keep **one** mode-0600 `qualification.raw` instead of
   * `stdout`/`stderr`. Absent, the ordinary two-stream capture is unchanged.
   */
  qualification?: boolean;
  hooks?: QualificationCaptureHooks;
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
  options: OpenHostRunRetainedOutputOptions = {},
): HostRunRetainedOutput {
  const paths = hostRunSupervisorPaths(stateDir, runId);
  if (options.qualification) {
    // One writer, one file: O_EXCL means a second open of the same run refuses
    // rather than appending to another writer's artifact.
    const fd = openVerifiedOwnedFile(stateDir, ["runs", runId, "qualification.raw"],
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let capture: QualificationRawCapture;
    try { capture = new QualificationRawCapture(paths.qualificationRawPath, fd, options.hooks ?? {}); }
    catch (error) {
      // The magic never landed; the empty artifact is left where it is, never
      // removed, so a faulted attempt cannot read as no attempt.
      try { closeSync(fd); } catch { /* already unusable */ }
      throw error;
    }
    return {
      mode: "qualification",
      write: (stream, chunk) => capture.write(stream, chunk),
      markEof: stream => capture.markEof(stream),
      markDrained: stream => capture.markDrained(stream),
      close: () => capture.close(),
      truncation: () => ({ stdout: null, stderr: null }),
    };
  }

  const files = {
    stdout: { fd: appendStream(stateDir, ["runs", runId, "stdout"]), state: { written: 0, observed: 0, capped: false } as RetainedStreamState },
    stderr: { fd: appendStream(stateDir, ["runs", runId, "stderr"]), state: { written: 0, observed: 0, capped: false } as RetainedStreamState },
  };
  let closed = false;
  let closedResult: HostRunRetainedOutputClose | null = null;
  const sinks = {
    stdout: tokenRedactor(secret, bytes => publish("stdout", bytes)),
    stderr: tokenRedactor(secret, bytes => publish("stderr", bytes)),
  };
  const publish = (stream: HostRunRetainedOutputStream, bytes: Buffer) => {
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
    mode: "streams",
    write(stream, chunk) {
      if (closed || !chunk.length) return;
      sinks[stream].write(chunk);
    },
    // The ordinary capture has no framed terminal markers; its EOF is the close.
    markEof() { /* no framed markers in the two-stream capture */ },
    markDrained() { /* no framed markers in the two-stream capture */ },
    close() {
      if (closed) return closedResult!;
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
      closedResult = { qualification: null, faults: [] };
      return closedResult;
    },
    truncation() {
      return { stdout: truncationOf(files.stdout.state), stderr: truncationOf(files.stderr.state) };
    },
  };
}
