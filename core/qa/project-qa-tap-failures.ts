import { tokenRedactor } from "../machine/token-redactor";
import { StringDecoder } from "node:string_decoder";
import { PROJECT_QA_FAILURE_LOCATION_MAX, type ProjectQaFailureIndex } from "../../shared/contracts";

/** Bound a location at the wire boundary and make any loss explicit. */
export function boundedFailureLocation(location: string | null) {
  return location !== null && location.length > PROJECT_QA_FAILURE_LOCATION_MAX
    ? { location: location.slice(0, PROJECT_QA_FAILURE_LOCATION_MAX), locationTrimmed: true as const }
    : { location };
}

/** Diagnostic excerpt budget; identity lines are retained outside this budget. */
export const PROJECT_QA_FAILURES_BYTES = 32_768;
const PROJECT_QA_TAP_BLOCK_CHARS = 8_192;
const PROJECT_QA_TAP_SUMMARY_CHARS = 256;

/**
 * Task 191: keep bounded `not ok` diagnostics and the TAP summary in a separate
 * failures log, independent of the output byte caps. Task 290 adds a separate,
 * compact identity index so a huge early diagnostic cannot evict later tests.
 * Task 590 adds the node spec reporter's trailing `✖ failing tests:` section:
 * each `✖` title opens a block with its indented diagnostics, and the `ℹ`
 * counts join the `#` ones in the summary.
 *
 * Feed output through `push` as it arrives — the executor calls it per chunk
 * before any maxOutputBytes tail-capping — so an early failure survives even
 * when the retained 64 KiB tail evicts it. A `not ok` line opens a block that
 * runs through following blank and indented lines (node:test's YAML
 * diagnostics); the plan line and `# tests`, `# pass`, `# fail`,
 * `# cancelled`, `# skipped` and `# todo` lines form the summary. `result`
 * returns null when the observed output names no TAP or spec failure —
 * including a passing run and non-test output such as a compile error.
 */
export class StreamingTapFailures {
  private lineBuf = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly redactor = tokenRedactor(() => this.redactionToken, bytes => this.pushText(this.decoder.write(bytes)), true);
  private current: { id: number | null; title: string; location: string | null; cancelled: boolean; todo: boolean; block: string; spec: boolean; trimmed: boolean } | null = null;
  private readonly identities: Array<{ id: number | null; title: string; location: string | null; status: "failed" | "cancelled" }> = [];
  private observedFailures = 0;
  private observedCancelled = 0;
  private diagnosticsTruncated = false;
  private readonly blocks: Array<{ text: string; trimmed: boolean }> = [];
  private trimmedCases = 0;
  private readonly summary: string[] = [];
  private readonly counts: { tests: number | null; failed: number | null; cancelled: number | null; skipped: number | null } = {
    tests: null, failed: null, cancelled: null, skipped: null,
  };
  private finished = false;
  private failureLog: string | null = null;
  private failureIndex: Omit<ProjectQaFailureIndex, "stage"> | null = null;

  constructor(private readonly redactionToken?: string, private readonly diagnosticBudget = PROJECT_QA_FAILURES_BYTES) {}

  /** Observe one output chunk; split lines survive chunk boundaries. */
  push(chunk: Buffer | string): void {
    this.redactor.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  private pushText(text: string): void {
    if (!text) return;
    const lines = (this.lineBuf + text).split("\n");
    this.lineBuf = lines.pop() ?? "";
    for (const line of lines) this.pushLine(line);
  }

  private pushLine(line: string): void {
    if (/^\s*not ok\b/.test(line)) {
      this.flush();
      const match = /^\s*not ok\s+(\d+)(?:\s*-\s*(.*))?/.exec(line);
      const title = (match?.[2] ?? line.replace(/^\s*not ok\s*/, ""));
      this.current = { id: match ? Number(match[1]) : null, title, location: null,
        cancelled: /#\s*(?:time\s*out|cancelled|canceled)\b/i.test(line), todo: /#\s*TODO\b/i.test(line), block: line.slice(0, PROJECT_QA_TAP_BLOCK_CHARS), spec: false, trimmed: false };
      return;
    }
    // Task 590: milestone QA may report through the node spec reporter (a
    // piped stream selects TAP, but a stage that forces spec, or a runner
    // summarizing spec-style, prints a trailing `✖ failing tests:` section).
    // Those failures get the same bounded excerpts and identities as TAP.
    if (/^\s*\u2716\s+failing tests:\s*$/.test(line)) { this.flush(); return; }
    const specFail = /^\s*\u2716\s+(.*\S)\s*$/.exec(line);
    if (specFail) {
      this.flush();
      const title = specFail[1];
      this.current = { id: null, title, location: null,
        cancelled: false, todo: false, block: line.slice(0, PROJECT_QA_TAP_BLOCK_CHARS), spec: true, trimmed: false };
      return;
    }
    const count = /^\s*(?:#|\u2139)\s*(tests|fail|cancelled|skipped)\s+(\d+)\b/i.exec(line);
    if (/^\s*1\.\.\d+/.test(line) || count || /^\s*(?:#|\u2139)\s*(suites|pass|todo)\b/i.test(line)) {
      this.flush();
      if (count) {
        const key = count[1].toLowerCase() === "fail" ? "failed" : count[1].toLowerCase() as "tests" | "cancelled" | "skipped";
        this.counts[key] = Number(count[2]);
      }
      if (this.summary.length < 40) {
        this.summary.push(line.slice(0, PROJECT_QA_TAP_SUMMARY_CHARS));
        if (line.length > PROJECT_QA_TAP_SUMMARY_CHARS) this.diagnosticsTruncated = true;
      }
      else this.diagnosticsTruncated = true;
      return;
    }
    if (/^\s*(?:ok\b|\u2714)/.test(line)) { this.flush(); return; }
    if (this.current && (line.trim() === "" || /^\s/.test(line))) {
      const location = /^\s*location:\s*['"]?([^'"]+)/i.exec(line)?.[1]
        ?? /((?:file:\/\/)?[^()\s]+:\d+:\d+)\)?\s*$/.exec(line)?.[1];
      if (!this.current.location && location) this.current.location = location;
      if (/\b(?:cancelled|canceled|cancelledByParent|cancelledByTimeout)\b/i.test(line)) this.current.cancelled = true;
      const separator = this.current.block ? "\n" : "";
      const remaining = Math.max(0, PROJECT_QA_TAP_BLOCK_CHARS - this.current.block.length - separator.length);
      if (line.length > remaining) this.current.trimmed = true;
      if (remaining > 0) this.current.block += separator + line.slice(0, remaining);
      return;
    }
    this.flush();
  }

  private flush(): void {
    if (!this.current) return;
    const current = this.current;
    // A spec `\u2716` title also prints inline as the test fails, ahead of the
    // trailing details section that carries its diagnostics. A block that
    // never grew past its title is that inline echo, not a failure excerpt:
    // dropping it keeps one identity per failing test.
    if (current.spec && !current.block.includes("\n")) { this.current = null; return; }
    // TAP TODO failures are expected failures and are absent from the suite's
    // failed count, so they must not become failure identities either.
    if (current.todo) { this.current = null; return; }
    const status = current.cancelled ? "cancelled" : "failed";
    this.observedFailures++;
    if (current.cancelled) this.observedCancelled++;
    const identity = { id: current.id, title: current.title, ...boundedFailureLocation(current.location), status } as const;
    this.identities.push(identity);

    this.blocks.push({ text: current.block, trimmed: current.trimmed });
    this.current = null;
  }

  private finish(): void {
    if (this.finished) return;
    this.redactor.flush();
    this.pushText(this.decoder.end());
    if (this.lineBuf) { this.pushLine(this.lineBuf); this.lineBuf = ""; }
    this.flush();
    // TAP's cancellation count is authoritative when the block itself carries
    // no cancellation marker. Node's runner commonly reports cancelled tests
    // as not-ok blocks with a parent/timeout diagnostic rather than a suffix.
    const expectedCancelled = this.counts.cancelled ?? this.observedCancelled;
    let unlabelled = Math.max(0, expectedCancelled - this.observedCancelled);
    for (let at = this.identities.length - 1; at >= 0 && unlabelled > 0; at--) {
      if (this.identities[at].status === "failed") {
        this.identities[at] = { ...this.identities[at], status: "cancelled" };
        unlabelled--;
      }
    }
    const expectedIdentities = (this.counts.failed ?? Math.max(0, this.observedFailures - this.observedCancelled))
      + (this.counts.cancelled ?? this.observedCancelled);
    const omittedIdentities = Math.max(0, this.observedFailures - this.identities.length, expectedIdentities - this.identities.length);
    const truncated = omittedIdentities > 0;
    const hasFailure = this.observedFailures > 0 || (this.counts.failed ?? 0) > 0 || (this.counts.cancelled ?? 0) > 0;
    if (hasFailure) {
      const tail = this.summary.join("\n");
      // Identity lines are never budgeted away. Divide the diagnostic budget
      // fairly so early failures cannot consume the entire log.
      const budget = Math.floor(Math.max(0, this.diagnosticBudget - 2048) / Math.max(1, this.blocks.length));
      const blocks = this.blocks.map((block, i) => {
        const identity = this.identities[i];
        const heading = `${identity.id === null ? "✖" : `not ok ${identity.id} -`} ${identity.title}${identity.location ? ` (${identity.location})` : ""}`;
        const newline = block.text.indexOf("\n");
        const diagnostics = newline < 0 ? "" : block.text.slice(newline + 1);
        const excerpt = diagnostics.slice(0, budget);
        if (block.trimmed || excerpt.length < diagnostics.length) this.trimmedCases++;
        return [heading, excerpt].filter(Boolean).join("\n");
      });
      if (this.trimmedCases) this.diagnosticsTruncated = true;
      const marker = this.diagnosticsTruncated ? `…[diagnostics truncated; ${this.trimmedCases} case(s) trimmed in log]…` : "";
      this.failureLog = [blocks.join("\n"), marker, tail].filter(Boolean).join("\n") || "Test failures were reported.";
      this.failureIndex = {
        tests: this.counts.tests,
        failed: this.counts.failed ?? Math.max(0, this.observedFailures - this.observedCancelled),
        cancelled: this.counts.cancelled ?? this.observedCancelled,
        skipped: this.counts.skipped,
        identities: this.identities,
        omittedIdentities,
        truncated,
        diagnosticsTruncated: this.diagnosticsTruncated,
      };
    }
    this.finished = true;
  }

  result(): string | null {
    this.finish();
    return this.failureLog;
  }

  index(): Omit<ProjectQaFailureIndex, "stage"> | null {
    this.finish();
    return this.failureIndex;
  }
}

export function redactFailureIndex(index: Omit<ProjectQaFailureIndex, "stage"> | null, token: string | undefined): Omit<ProjectQaFailureIndex, "stage"> | null {
  if (!index || !token) return index;
  return { ...index, identities: index.identities.map(identity => ({ ...identity,
    title: identity.title.replaceAll(token, "[REDACTED]"),
    ...boundedFailureLocation(identity.location?.replaceAll(token, "[REDACTED]") ?? null),
  })) };
}

export function failureCoverageDetail(indexes: readonly ProjectQaFailureIndex[]): string {
  return indexes.map(index => {
    const failed = index.failed === null ? "unknown" : String(index.failed);
    const cancelled = index.cancelled === null ? "unknown" : String(index.cancelled);
    const coverage = `${index.identities.length} identities retained, ${index.omittedIdentities} omitted`;
    const diagnostics = index.diagnosticsTruncated ? "; diagnostics truncated" : "";
    const indexGap = index.truncated ? "; failure index truncated" : "";
    return `${index.stage}: ${failed} failed, ${cancelled} cancelled; ${coverage}${diagnostics}${indexGap}`;
  }).join("\n");
}

/** Append one stage without discarding identities from earlier stages. */
export function appendFailuresLog(existing: string | undefined, extracted: string | null, stage: string): string {
  if (!extracted) return existing ?? "";
  const headed = `### ${stage}\n${extracted}`;
  return existing ? `${existing}\n${headed}` : headed;
}
