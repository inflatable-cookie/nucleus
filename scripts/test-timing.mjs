// Runs wall-clock oracles alone, one test at a time, after the parallel suite:
// performance oracles and the serial roll-acceptance files. CPU-time budgets
// and endpoint-gap windows measure Queue work; INCONCLUSIVE remains a last
// resort for failures during host saturation that still need diagnosis.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durationReporterArgs, durationTablePath, flushDurationTable } from "./duration-reporter.mjs";
import { selectTimingFiles } from "./timing-source.mjs";
import { runnerFlags } from "./test-runner-flags.mjs";
import { timingVerdict } from "./timing-verdict.mjs";

const requested = process.argv.slice(2);
const pattern = requested.find(arg => arg.startsWith("--test-name-pattern=")) ?? "--test-name-pattern=^timing: ";
const files = selectTimingFiles(requested.filter(arg => !arg.startsWith("--test-name-pattern=")), readdirSync("test"), file => readFileSync(file, "utf8"));
const cores = availableParallelism(), strict = process.env.QUEUE_TIMING_STRICT === "1";
const before = loadavg()[0];
const table = durationTablePath();
const evidenceRoot = mkdtempSync(join(tmpdir(), "queue-timing-"));
const evidencePath = join(evidenceRoot, "failures.json");
const status = spawnSync("npx", ["tsx", ...runnerFlags(1, 600000), pattern, ...durationReporterArgs(), `--test-reporter=${fileURLToPath(new URL("./timing-reporter.mjs", import.meta.url))}`, "--test-reporter-destination=/dev/null", ...files],
  { stdio: "inherit", env: { ...process.env, QUEUE_TEST_LANE: "timing", QUEUE_QA_DURATIONS_FILE: table, QUEUE_TIMING_FAILURES_FILE: evidencePath } }).status;
flushDurationTable(table);
let evidence;
try { evidence = JSON.parse(readFileSync(evidencePath, "utf8")); } catch { /* missing proof fails closed */ }
rmSync(evidenceRoot, { recursive: true, force: true });
const result = timingVerdict({ ...evidence, status, loads: [before, loadavg()[0]], cores, strict });
if (result.verdict === "inconclusive") {
  console.error(`\ntest:timing: INCONCLUSIVE. ${evidence.failures.length} performance oracles failed while host load was ${result.load.toFixed(1)} on ${cores} cores. Failed oracles: ${evidence.failures.map(failure => failure.name).join("; ")}. Investigate the failures; QUEUE_TIMING_STRICT=1 makes it fail QA.\n`);
}
process.exit(result.exit);
