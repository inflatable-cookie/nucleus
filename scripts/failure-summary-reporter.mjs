// Preserve test failures separately from the console stream, which may be cut
// off by a long affected run's output limit.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export default async function* failureSummary(source) {
  const failures = [];
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const data = event.data ?? {};
    const file = data.file ? relative(process.cwd(), String(data.file)) : '<unknown file>';
    const name = String(data.name ?? '<unnamed test>');
    failures.push(`- ${file}: ${name}`);
  }
  const summary = failures.length
    ? `Test failure summary (${failures.length})\n${failures.join('\n')}\n`
    : '';
  const destination = process.env.QUEUE_TEST_FAILURES_FILE;
  if (destination) try { writeFileSync(destination, summary); } catch { /* best effort */ }
}

export function failureSummaryArgs() {
  return [
    `--test-reporter=${fileURLToPath(new URL('./failure-summary-reporter.mjs', import.meta.url))}`,
    '--test-reporter-destination=/dev/null',
  ];
}

export function failureSummaryPath() {
  return join(tmpdir(), `queue-test-failures-${process.pid}-${Date.now()}.txt`);
}

export function flushFailureSummary(destination) {
  try {
    const summary = readFileSync(destination, 'utf8');
    if (summary) {
      process.stderr.on('error', () => {});
      process.stderr.write(`\n${summary}Failure summary file: ${destination}\n`);
    }
  } catch { /* no summary, or stderr is gone: the test result stands */ }
}
