// Node test reporter for the QA artifact: when a run ends it writes one table of
// per-file wall time, slowest first, with the lane's total. Nothing here may
// change a run's outcome: the reporter yields nothing to Node (its destination
// is /dev/null) and writes the table itself, best effort, to the file the lane
// names in QUEUE_QA_DURATIONS_FILE. The lane copies it to stderr afterwards and
// ignores every error there too.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export default async function* durations(source) {
  const files = new Map();
  const failures = [];
  let total = null;
  for await (const event of source) {
    const data = event.data ?? {};
    // Each file reports one file-level completion named after the file itself.
    if (event.type === "test:complete" && data.file && data.nesting === 0 && basename(String(data.name)) === basename(data.file))
      files.set(relative(process.cwd(), data.file), { ms: data.details?.duration_ms ?? 0, failed: Boolean(data.details?.error) });
    if (event.type === "test:fail") {
      const file = data.file ? relative(process.cwd(), String(data.file)) : "<unknown file>";
      failures.push(`- ${file}: ${String(data.name ?? "<unnamed test>")}`);
    }
    else if (event.type === "test:summary" && !data.file) total = data.duration_ms ?? null;
  }
  const lane = process.env.QUEUE_TEST_LANE || "parallel";
  const seconds = ms => (ms / 1000).toFixed(1).padStart(7);
  const rows = [...files].sort((a, b) => b[1].ms - a[1].ms)
    .map(([file, { ms, failed }]) => `${seconds(ms)} s  ${file}${failed ? "  (failed)" : ""}`);
  const table = `\nqa-durations: ${lane} lane, ${files.size} files${total === null ? "" : `, ${(total / 1000).toFixed(1)} s wall`}\n${rows.join("\n")}\n`;
  const destination = process.env.QUEUE_QA_DURATIONS_FILE;
  if (destination) try { writeFileSync(destination, table); } catch { /* best effort */ }
  const failureDestination = process.env.QUEUE_TEST_FAILURES_FILE;
  if (failureDestination && failures.length) try {
    writeFileSync(failureDestination, `Test failure summary (${failures.length})\n${failures.join("\n")}\n`);
  } catch { /* best effort */ }
}

/** A fresh file for one run's table. */
export function durationTablePath() {
  return join(tmpdir(), `queue-qa-durations-${process.pid}-${Date.now()}.txt`);
}

/** A fresh file for one run's retained failing file and test names. */
export function failureSummaryPath() {
  return join(tmpdir(), `queue-test-failures-${process.pid}-${Date.now()}.txt`);
}

/** Print the persisted failure summary after the ordinary output and duration table. */
export function flushFailureSummary(destination) {
  try {
    const summary = readFileSync(destination, "utf8");
    if (summary) {
      process.stderr.on("error", () => {});
      process.stderr.write(`\n${summary}Failure summary file: ${destination}\n`);
    }
  } catch { /* no summary, or stderr is gone: the test result stands */ }
}

/** Keep the default console reporter on stdout; the duration reporter's own output is empty. */
export function durationReporterArgs(tty = Boolean(process.stdout.isTTY)) {
  return [
    `--test-reporter=${tty ? "spec" : "tap"}`, "--test-reporter-destination=stdout",
    `--test-reporter=${fileURLToPath(import.meta.url)}`, "--test-reporter-destination=/dev/null",
  ];
}

/** Copy the table to stderr and remove the file. Best effort: it never changes the run's outcome. */
export function flushDurationTable(destination) {
  try {
    const table = readFileSync(destination, "utf8");
    process.stderr.on("error", () => {});
    process.stderr.write(table);
  } catch { /* no table, or stderr is gone: the test result stands */ }
  try { rmSync(destination, { force: true }); } catch { /* best effort */ }
}
