/**
 * Bounded diagnostics for one captured output stream (task 388).
 *
 * The executor's per-stream byte cap used to keep only the tail of a long
 * stream and drop its beginning without a word, and a QA step then re-split that
 * tail as if its first bytes were the beginning of the output. Capped evidence
 * therefore read as complete output. This module keeps a bounded beginning and
 * end inside the same total byte cap the caller already pays, and states what
 * was cut and how many bytes were observed, retained and omitted. It never
 * raises a byte, memory or timeout budget and never recovers a dropped byte by
 * inference: an omitted count is evidence that the bytes are gone, not a claim
 * about what they said.
 *
 * The executor, the QA step projection and the bounded QA detail/output tails
 * all render their markers here, so one owner decides their text.
 */

/** What one stream's cap did: bytes the stream produced, and bytes it never kept. */
export interface StreamTruncation {
  observedBytes: number;
  omittedBytes: number;
}

/** The stream this evidence came from, so a message can name it. */
export type StreamName = "stdout" | "stderr";

/** True when the counts prove the cap dropped bytes, so evidence must say so. */
export function wasTruncated(truncation: StreamTruncation | null | undefined): truncation is StreamTruncation {
  return Boolean(truncation && truncation.omittedBytes > 0);
}

/** The truncation an executor reported for one stream, or null when it kept every byte. */
export function streamTruncation(observedBytes?: number | null, omittedBytes?: number | null): StreamTruncation | null {
  if (observedBytes === undefined || observedBytes === null || !omittedBytes) return null;
  return { observedBytes, omittedBytes };
}

/**
 * One bracketed, single-line marker. It says how many bytes the stream produced,
 * how many were kept and omitted, and (when the caller knows it) the cap that
 * caused the loss. `beginning and end kept` is the executor's default retention
 * shape; a failure-first stream names what it trimmed instead. The marker never
 * implies the retained bytes are contiguous or complete.
 */
export function streamTruncationMarker(truncation: StreamTruncation, capBytes?: number, shapeNote?: string): string {
  const retainedBytes = Math.max(0, truncation.observedBytes - truncation.omittedBytes);
  const cap = capBytes === undefined ? "" : ` cap=${capBytes}`;
  return `[queue: output truncated: observed=${truncation.observedBytes} retained=${retainedBytes} omitted=${truncation.omittedBytes}${cap}; ${shapeNote ?? "beginning and end kept"}]`;
}

/** Keep the longest prefix that ends on a UTF-8 character boundary. */
function utf8Head(buffer: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, buffer.length); back++) {
    const byte = buffer[buffer.length - back];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep scanning back
    if ((byte & 0x80) === 0) return buffer.subarray(0, buffer.length - back + 1); // ASCII ends the sequence
    const need = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
    return need === back ? buffer : buffer.subarray(0, buffer.length - back);
  }
  return buffer.subarray(0, Math.max(0, buffer.length - Math.min(4, buffer.length)));
}

/** Drop leading continuation bytes so the retained end starts on a character boundary. */
function utf8Tail(buffer: Buffer): Buffer {
  let start = 0;
  while (start < Math.min(3, buffer.length) && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

/** How many chunks one stream's tail may hold before they are coalesced. */
const TAIL_CHUNK_LIMIT = 128;

/**
 * One stream's bounded retention: a beginning buffer and a tail window whose
 * total never exceeds the stream's existing byte cap, plus the byte accounting
 * that lets the caller say what was dropped.
 *
 * `push` is called for every chunk as it arrives, so memory stays at the cap
 * rather than the stream's length. `render` returns the bytes to record:
 * byte-identical to the whole stream when it fit, and otherwise the beginning,
 * one marker line and the end, still within the cap.
 */
export class BoundedStreamRetention {
  private readonly headChunks: Buffer[] = [];
  private readonly tailChunks: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private observed = 0;
  private readonly headCap: number;
  private readonly tailCap: number;

  /**
   * `keepEnd` splits the cap between the beginning and the end (a diagnostic
   * stream). Without it the whole cap keeps the contiguous beginning, which is
   * the old behaviour an output-limit kill relies on.
   */
  constructor(private readonly capBytes: number, keepEnd = true) {
    this.headCap = keepEnd ? Math.floor(Math.max(0, capBytes) / 2) : Math.max(0, capBytes);
    this.tailCap = Math.max(0, Math.max(0, capBytes) - this.headCap);
  }

  private rendered: StreamTruncation | null = null;

  /** Bytes this stream produced, before the cap. */
  get observedBytes(): number { return this.observed; }

  /**
   * Bytes the cap never kept. After `render` this is the count the recorded
   * marker states, so the two can never disagree about what was lost.
   */
  get omittedBytes(): number {
    return this.rendered?.omittedBytes ?? Math.max(0, this.observed - this.headBytes - this.tailBytes);
  }

  get exceeded(): boolean { return this.observed > this.capBytes; }

  /** Count bytes the stream produced without retaining them (the kept prefix is already full). */
  observe(chunk: Buffer): void {
    this.observed += chunk.length;
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.observed += chunk.length;
    let rest = chunk;
    const headRoom = this.headCap - this.headBytes;
    if (headRoom > 0) {
      const take = Math.min(headRoom, rest.length);
      this.headChunks.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (!rest.length) return;
    this.tailChunks.push(rest);
    this.tailBytes += rest.length;
    if (this.tailChunks.length > TAIL_CHUNK_LIMIT) this.coalesceTail();
    this.trimTail();
  }

  private coalesceTail(): void {
    const merged = Buffer.concat(this.tailChunks);
    this.tailChunks.length = 0;
    if (merged.length) this.tailChunks.push(merged);
    this.tailBytes = merged.length;
  }

  private trimTail(): void {
    while (this.tailBytes > this.tailCap && this.tailChunks.length) {
      const excess = this.tailBytes - this.tailCap;
      const first = this.tailChunks[0];
      if (first.length <= excess) { this.tailChunks.shift(); this.tailBytes -= first.length; continue; }
      this.tailChunks[0] = first.subarray(excess);
      this.tailBytes -= excess;
    }
  }

  /** Retained content trimmed to `budget` bytes, beginning first and end last. */
  private trimTo(budget: number): { head: Buffer; tail: Buffer; bytes: number } {
    const headAll = Buffer.concat(this.headChunks);
    const tailAll = Buffer.concat(this.tailChunks);
    if (headAll.length + tailAll.length <= budget) {
      const head = utf8Head(headAll);
      const tail = utf8Tail(tailAll);
      return { head, tail, bytes: head.length + tail.length };
    }
    // The marker takes its room from the omitted middle, so the end gives way first.
    let over = headAll.length + tailAll.length - budget;
    const trimTail = Math.min(over, tailAll.length);
    const tailTrimmed = tailAll.subarray(trimTail);
    over -= trimTail;
    const headTrimmed = over > 0 ? headAll.subarray(0, headAll.length - over) : headAll;
    const head = utf8Head(headTrimmed);
    const tail = utf8Tail(tailTrimmed);
    return { head, tail, bytes: head.length + tail.length };
  }

  /**
   * The bytes to record. With `marker: false` (an output-limit kill, whose
   * partial output is never accepted) the retained prefix is returned as is.
   */
  render(marker = true): Buffer {
    if (!marker || !this.exceeded || this.capBytes <= 0) {
      const kept = Buffer.concat([...this.headChunks, ...this.tailChunks]);
      this.rendered = { observedBytes: this.observed, omittedBytes: Math.max(0, this.observed - kept.length) };
      return kept;
    }
    const countsFor = (retainedBytes: number): StreamTruncation => ({
      observedBytes: this.observed, omittedBytes: Math.max(0, this.observed - retainedBytes),
    });
    // The cap leaves room for the marker; its numbers settle after one or two passes.
    let budget = Math.max(0, this.capBytes - Buffer.byteLength(streamTruncationMarker(countsFor(this.capBytes), this.capBytes)));
    let kept = this.trimTo(budget);
    let markerText = streamTruncationMarker(countsFor(kept.bytes), this.capBytes);
    for (let pass = 0; pass < 4; pass++) {
      // The recorded bytes are the beginning, one marker line and the end.
      const next = Math.max(0, this.capBytes - Buffer.byteLength(markerText) - 2);
      if (next === budget) break;
      budget = next;
      kept = this.trimTo(budget);
      markerText = streamTruncationMarker(countsFor(kept.bytes), this.capBytes);
    }
    // A marker longer than the whole cap can only stand for itself.
    const markerBytes = Buffer.from(`\n${markerText}\n`);
    if (markerBytes.length >= this.capBytes) {
      this.rendered = countsFor(0);
      return markerBytes.subarray(0, this.capBytes);
    }
    let head = kept.head;
    let tail = kept.tail;
    let excess = head.length + tail.length + markerBytes.length - this.capBytes;
    if (excess > 0) {
      const trimTail = Math.min(excess, tail.length);
      tail = utf8Tail(tail.subarray(trimTail));
      excess -= trimTail;
      if (excess > 0) head = utf8Head(head.subarray(0, Math.max(0, head.length - excess)));
    }
    this.rendered = countsFor(head.length + tail.length);
    return Buffer.concat([head, markerBytes, tail]);
  }
}

/**
 * The bounded head and tail of one retained stream for a QA step record. With
 * truncation counts the marker is part of both excerpts, inside the existing
 * per-field character bound, so a reader of either one learns that the stream
 * was cut and by how much.
 */
export function boundedHeadTail(buffer: Buffer, limit: number, truncation?: StreamTruncation | null, shapeNote?: string): { head: string; tail: string } {
  if (!wasTruncated(truncation)) {
    if (buffer.length <= limit * 2) return { head: buffer.toString("utf8"), tail: "" };
    return { head: buffer.subarray(0, limit).toString("utf8"), tail: buffer.subarray(-limit).toString("utf8") };
  }
  const marker = streamTruncationMarker(truncation, undefined, shapeNote);
  const content = Math.max(0, limit - Buffer.byteLength(marker) - 1);
  const headEnd = Math.min(buffer.length, content);
  const headBytes = utf8Head(buffer.subarray(0, headEnd));
  const tailStart = Math.max(headEnd, buffer.length - content);
  const tailBytes = tailStart < buffer.length ? utf8Tail(buffer.subarray(tailStart)) : Buffer.alloc(0);
  const head = headBytes.toString("utf8");
  const tail = tailBytes.toString("utf8");
  return {
    head: head ? `${head}\n${marker}` : marker,
    tail: tail ? `${marker}\n${tail}` : marker,
  };
}

/** The longest prefix that does not end on a lone surrogate. */
function stringHead(text: string, chars: number): string {
  let end = Math.min(Math.max(0, chars), text.length);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/** The longest suffix that does not start on a lone surrogate. */
function stringTail(text: string, chars: number): string {
  let start = Math.max(0, text.length - Math.max(0, chars));
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start])) start += 1;
  return text.slice(start);
}

/**
 * A bounded beginning and end of one text with the stream's marker between
 * them, for a field that is the only durable finding (the project-validation
 * result's `outputTail`). The marker and both ends fit the same character
 * bound, so the beginning reaches the record instead of being cut away by a
 * tail slice, and the text never reads as complete output.
 */
export function headTailWithMarker(text: string, limitChars: number, truncation: StreamTruncation): string {
  const marker = streamTruncationMarker(truncation);
  const content = limitChars - marker.length - 2;
  if (content <= 0) return marker.slice(0, Math.max(0, limitChars));
  if (text.length <= content) return text;
  const headChars = Math.ceil(content / 2);
  const head = stringHead(text, headChars);
  const tail = stringTail(text, content - headChars);
  return `${head}\n${marker}\n${tail}`.slice(0, limitChars);
}

/**
 * The bounded end of a longer text (the run's shared output tail and the
 * supervision detail) with a leading marker when earlier text was cut. The
 * marker fits inside the same character bound, so the string is never longer
 * than it was before, and it never reads as the whole output.
 */
export function tailWithTruncationMarker(text: string, limitChars: number): string {
  if (text.length <= limitChars) return text;
  const markerFor = (omittedChars: number): string =>
    `[queue: output truncated: ${omittedChars} earlier characters omitted]\n`;
  let keep = Math.max(0, limitChars - markerFor(Math.max(0, text.length - limitChars)).length);
  const marker = markerFor(Math.max(0, text.length - keep));
  keep = Math.max(0, limitChars - marker.length);
  return `${marker}${text.slice(-keep)}`.slice(-limitChars);
}

/** One output line's retention fate for a failure-first stream. */
export type FailureFirstLineKind = "failure" | "passing" | "other";

/** A line the failure-first classifier keeps apart from passing test output. */
export const FAILURE_FIRST_RETENTION_NOTE = "passing output trimmed first";

const TAP_FAILURE_OPEN = /^\s*not ok\b/;
const SPEC_FAILURE_OPEN = /^\s*\u2716/;
const SPEC_FAILURE_HEADER = /^\s*\u2716\s+failing tests:\s*$/;
const TAP_PASS_OPEN = /^\s*ok\b/;
const SPEC_PASS_OPEN = /^\s*\u2714/;
const BLANK_OR_INDENTED = /^\s*$/;
const INDENTED = /^\s/;

type FailureFirstBlock = "normal" | "passing" | "failure";

/**
 * Retention-grade test-output classification (TAP `not ok` blocks and node
 * spec-reporter `\u2716` failure sections). A failure opener starts a block
 * whose blank and indented continuations stay with it; a passing opener
 * (`ok`, `\u2714`) does the same for droppable passing lines. Anything else
 * resets to `other`, which the retention keeps head-and-tail. Unknown output
 * is `other`, never `passing`: a format this does not recognize degrades to
 * today's head-and-tail shape instead of dropping lines it cannot name.
 *
 * This mirrors the milestone failure collector's block tracking closely enough
 * for retention: misclassification only moves bytes between the kept pools,
 * never out of the failures log the collector builds from the same chunks.
 */
export function classifyFailureFirstLine(line: string, block: FailureFirstBlock): { kind: FailureFirstLineKind; block: FailureFirstBlock } {
  if (SPEC_FAILURE_HEADER.test(line)) return { kind: "other", block: "normal" };
  if (TAP_FAILURE_OPEN.test(line) || SPEC_FAILURE_OPEN.test(line)) return { kind: "failure", block: "failure" };
  if (TAP_PASS_OPEN.test(line) || SPEC_PASS_OPEN.test(line)) return { kind: "passing", block: "passing" };
  if (BLANK_OR_INDENTED.test(line) || INDENTED.test(line)) {
    if (block === "failure") return { kind: "failure", block };
    if (block === "passing") return { kind: "passing", block };
    return { kind: "other", block };
  }
  return { kind: "other", block: "normal" };
}

interface SequencedLine { seq: number; kind: FailureFirstLineKind; bytes: Buffer }

/**
 * Failure-first retention for milestone QA stages (task 590): passing test
 * lines (`ok`, `\u2714` and their diagnostic continuations) are trimmed before
 * failure lines, so a capped step log keeps the failures a fix worker needs
 * instead of whichever passing output happened to surround them.
 *
 * The stream is split into lines (the `\n` stays with its line, so a stream
 * that fits is returned byte-identical) and stored in three pools: failure
 * lines first-come within the cap, other lines head-and-tail within the cap,
 * passing lines head-and-tail within the cap. Rendering merges the survivors
 * back into chronological order and trims to the cap by priority: passing
 * lines oldest-first, then other lines oldest-first (their tails carry the
 * runner summaries), then the newest failure lines. The leading marker names
 * what was actually trimmed, with byte counts, so the log never reads as
 * complete output. Memory stays bounded near three times the cap even when
 * one pool dominates, and one unterminated line holds at most the cap: when
 * the line so far would grow past the cap it is stored as a piece and its
 * continuation becomes the next piece, with the opener's classification and
 * a later sequence number, so a stream that never emits a newline cannot
 * grow memory for the whole run. Piece boundaries are invisible in the
 * rendered bytes; they only move bytes between the kept pools. Every stored
 * line is a copy, never a view of a caller's chunk, so retention never pins
 * a whole source chunk (or Node's pooled read buffer) alive until render.
 * The executor opts in per request and every other caller keeps today's
 * beginning-and-end shape.
 */
export class FailureFirstStreamRetention {
  private pending: Buffer = Buffer.alloc(0);
  private block: FailureFirstBlock = "normal";
  private seq = 0;
  private failures: SequencedLine[] = [];
  private failureBytes = 0;
  private otherHead: SequencedLine[] = [];
  private otherTail: SequencedLine[] = [];
  private otherTailHead = 0;
  private otherHeadBytes = 0;
  private otherTailBytes = 0;
  private passingHead: SequencedLine[] = [];
  private passingTail: SequencedLine[] = [];
  private passingTailHead = 0;
  private passingHeadBytes = 0;
  private passingTailBytes = 0;
  private observed = 0;
  /** True when `pending` continues a line already begun as stored pieces. */
  private pendingContinuation = false;
  private rendered: StreamTruncation | null = null;

  constructor(private readonly capBytes: number) {}

  /** Bytes this stream produced, before any trimming. */
  get observedBytes(): number { return this.observed; }

  /** Bytes the not-yet-terminated line currently holds; never past the cap. */
  get pendingBytes(): number { return this.pending.length; }

  /** Bytes the cap never kept, settled by the last `render`. */
  get omittedBytes(): number {
    return this.rendered?.omittedBytes ?? Math.max(0, this.observed - this.keptBytes());
  }

  get exceeded(): boolean { return this.observed > this.capBytes; }

  /** Count bytes the stream produced without retaining them. */
  observe(chunk: Buffer): void {
    this.observed += chunk.length;
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.observed += chunk.length;
    let buffer: Buffer;
    if (this.pending.length) {
      if (this.pending.length + chunk.length <= this.capBytes) {
        buffer = Buffer.concat([this.pending, chunk]);
      } else {
        // The unterminated line has reached its in-memory bound: store the
        // line so far under the opener's classification and let the rest of
        // this chunk continue the line as the next piece. A stream that
        // never emits a newline therefore holds at most the cap in memory,
        // with linear work per chunk, instead of growing `pending` without
        // bound until it renders.
        this.storeLine(this.pending, this.pendingContinuation);
        this.pendingContinuation = true;
        buffer = chunk;
      }
      this.pending = Buffer.alloc(0);
    } else {
      buffer = chunk;
    }
    let start = 0;
    let continuation = this.pendingContinuation;
    for (let at = 0; at < buffer.length; at++) {
      if (buffer[at] === 0x0a) {
        this.storeLine(buffer.subarray(start, at + 1), continuation);
        continuation = false;
        start = at + 1;
        continue;
      }
      // One chunk longer than the cap without a newline is held only in
      // cap-sized pieces, so even that path never keeps more than the cap.
      if (at > start && at - start >= this.capBytes) {
        this.storeLine(buffer.subarray(start, at), continuation);
        continuation = true;
        start = at;
      }
    }
    if (start < buffer.length) {
      // A copy, never a view: the caller may reuse its buffer, and a view
      // would keep the whole source chunk alive until the line completes.
      this.pending = Buffer.from(buffer.subarray(start));
      this.pendingContinuation = continuation;
    } else {
      this.pendingContinuation = false;
    }
  }

  /**
   * Store one line's bytes in its pool. A `continuation` piece is the middle
   * of a line already partly stored: it keeps the opener's classification and
   * block instead of re-classifying arbitrary mid-line bytes that only look
   * like another line's opener.
   */
  private storeLine(bytes: Buffer, continuation = false): void {
    const classified: { kind: FailureFirstLineKind; block: FailureFirstBlock } = continuation
      ? {
          kind: this.block === "failure" ? "failure" : this.block === "passing" ? "passing" : "other",
          block: this.block,
        }
      : classifyFailureFirstLine(bytes.toString("utf8"), this.block);
    this.block = classified.block;
    // Stored bytes are copies, never views: the caller may reuse its chunk,
    // and a view would pin the whole source chunk (or Node's pooled read
    // buffer) in the pools until render.
    const entry: SequencedLine = { seq: this.seq++, kind: classified.kind, bytes: Buffer.from(bytes) };
    if (classified.kind === "failure") {
      // First-come: a failure flood keeps its earliest whole lines and skips
      // the rest, so one huge block cannot evict every later failure. A line
      // larger than the whole cap still yields to later smaller failures.
      if (this.failures.length && this.failureBytes + bytes.length > this.capBytes) return;
      this.failures.push(entry);
      this.failureBytes += bytes.length;
      return;
    }
    const half = Math.max(1, Math.floor(this.capBytes / 2));
    if (classified.kind === "other") {
      if (this.otherHeadBytes < half) {
        this.otherHead.push(entry);
        this.otherHeadBytes += bytes.length;
      } else {
        this.otherTail.push(entry);
        this.otherTailBytes += bytes.length;
        while (this.otherTailBytes > half && this.otherTail.length - this.otherTailHead > 1) {
          this.otherTailBytes -= this.otherTail[this.otherTailHead++]!.bytes.length;
        }
        if (this.otherTailHead > 1024 && this.otherTailHead * 2 > this.otherTail.length) {
          this.otherTail.splice(0, this.otherTailHead);
          this.otherTailHead = 0;
        }
      }
      return;
    }
    if (this.passingHeadBytes < half) {
      this.passingHead.push(entry);
      this.passingHeadBytes += bytes.length;
    } else {
      this.passingTail.push(entry);
      this.passingTailBytes += bytes.length;
      while (this.passingTailBytes > half && this.passingTail.length - this.passingTailHead > 1) {
        this.passingTailBytes -= this.passingTail[this.passingTailHead++]!.bytes.length;
      }
      if (this.passingTailHead > 1024 && this.passingTailHead * 2 > this.passingTail.length) {
        this.passingTail.splice(0, this.passingTailHead);
        this.passingTailHead = 0;
      }
    }
  }

  private keptBytes(): number {
    return this.failureBytes + this.otherHeadBytes + this.otherTailBytes + this.passingHeadBytes + this.passingTailBytes;
  }

  /**
   * The bytes to record: the chronological survivors within the cap, or the
   * whole stream when it fit. With `marker: false` the survivors are returned
   * as is; otherwise a leading marker names what trimming removed.
   */
  render(marker = true): Buffer {
    if (this.pending.length) {
      // The final partial line is always stored whole: it is at most one
      // line past the pools' budgets, and render trims it by priority below.
      this.storeLine(this.pending, this.pendingContinuation);
      this.pending = Buffer.alloc(0);
    }
    const merged = [...this.failures, ...this.otherHead, ...this.otherTail.slice(this.otherTailHead), ...this.passingHead, ...this.passingTail.slice(this.passingTailHead)]
      .sort((a, b) => a.seq - b.seq);
    let kept = merged;
    let bytes = kept.reduce((sum, entry) => sum + entry.bytes.length, 0);
    // Trimming priority, oldest-first within a pool except failures: passing
    // output first (keeping the most recent passing lines beside the
    // failures), then other output oldest-first (its tails carry the runner
    // summaries), then the newest failure lines as a last resort.
    const markDrops = (need: number): void => {
      if (need <= 0) return;
      const dropped = new Set<SequencedLine>();
      let remaining = need;
      for (const entry of merged) {
        if (remaining <= 0) break;
        if (entry.kind === "passing") { dropped.add(entry); remaining -= entry.bytes.length; }
      }
      for (const entry of merged) {
        if (remaining <= 0) break;
        if (entry.kind === "other") { dropped.add(entry); remaining -= entry.bytes.length; }
      }
      for (let at = merged.length - 1; at >= 0 && remaining > 0; at--) {
        const entry = merged[at]!;
        if (entry.kind === "failure") { dropped.add(entry); remaining -= entry.bytes.length; }
      }
      kept = merged.filter(entry => !dropped.has(entry));
      bytes = kept.reduce((sum, entry) => sum + entry.bytes.length, 0);
    };
    const buildMarker = (): Buffer => {
      const keptSet = new Set(kept);
      const droppedKinds = new Set<FailureFirstLineKind>();
      for (const entry of merged) {
        if (!keptSet.has(entry)) droppedKinds.add(entry.kind);
      }
      const notes: string[] = [];
      if (droppedKinds.has("passing")) notes.push(FAILURE_FIRST_RETENTION_NOTE);
      if (droppedKinds.has("other")) notes.push("other output trimmed to its beginning and end");
      if (droppedKinds.has("failure")) notes.push("newest failure lines omitted");
      const counts: StreamTruncation = { observedBytes: this.observed, omittedBytes: Math.max(0, this.observed - bytes) };
      return Buffer.from(`${streamTruncationMarker(counts, this.capBytes, notes.join("; ") || FAILURE_FIRST_RETENTION_NOTE)}\n`);
    };
    // Leave room for the marker before trimming, then settle exactly: the
    // marker is well under 512 bytes, so the second loop rarely trims again.
    // A stream that fits is returned untouched, marker room included.
    if (bytes > this.capBytes) markDrops(bytes + 512 - this.capBytes);
    let markerBytes = buildMarker();
    while (markerBytes.length + bytes > this.capBytes) {
      const before = kept.length;
      markDrops(markerBytes.length + bytes - this.capBytes);
      markerBytes = buildMarker();
      if (kept.length === before) break;
    }
    const keptBytes = bytes;
    this.rendered = { observedBytes: this.observed, omittedBytes: Math.max(0, this.observed - keptBytes) };
    if (!marker || !wasTruncated(this.rendered)) return Buffer.concat(kept.map(entry => entry.bytes));
    // A marker longer than the whole cap can only stand for itself.
    if (markerBytes.length >= this.capBytes) {
      this.rendered = { observedBytes: this.observed, omittedBytes: this.observed };
      return markerBytes.subarray(0, this.capBytes);
    }
    let rendered = Buffer.concat([markerBytes, ...kept.map(entry => entry.bytes)]);
    if (rendered.length > this.capBytes) {
      // The marker's room comes from the kept tail, never past the cap.
      rendered = Buffer.concat([markerBytes, rendered.subarray(markerBytes.length, this.capBytes)]);
    }
    return rendered;
  }
}
