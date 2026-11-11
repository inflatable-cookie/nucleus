import { writeFileSync } from "node:fs";
import { timingFailure } from "./timing-verdict.mjs";

// An independent reporter preserves structured error types without parsing TAP
// diagnostics or buffering the lane's console output. An incomplete run is not proof.
export default async function* timingFailures(source) {
  const failures = [];
  let summary;
  for await (const event of source) {
    if (event.type === "test:fail") {
      const failure = timingFailure(event.data);
      if (failure) failures.push(failure);
    }
    if (event.type === "test:summary" && !event.data.file) summary = event.data.counts;
  }
  if (summary && process.env.QUEUE_TIMING_FAILURES_FILE)
    writeFileSync(process.env.QUEUE_TIMING_FAILURES_FILE, JSON.stringify({ failures, failed: summary.failed, cancelled: summary.cancelled }));
}
