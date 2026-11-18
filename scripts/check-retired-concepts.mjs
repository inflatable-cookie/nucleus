import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Compare a multiset, so adding another copy of an existing finding still fails. */
export function newFindings(findings, baseline) {
  const remaining = new Map(Object.entries(baseline));
  return findings.filter(finding => {
    const fields = ['id', 'kind', 'needle', 'file', 'text'].map(key => finding[key] ?? '');
    const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const count = remaining.get(digest) ?? 0;
    if (count > 0) { remaining.set(digest, count - 1); return false; }
    return true;
  });
}

function main() {
  const result = spawnSync('effigy', ['skill', 'run', 'northstar/retired-concepts', '--stdio', 'passthrough', '--', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    process.stderr.write(`retired-concepts: scanner failed: ${result.error ?? result.stderr}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const report = JSON.parse(result.stdout);
    if (!Array.isArray(report.findings) || !['ok', 'violations'].includes(report.status)) throw Error('invalid scanner response');
    const baseline = JSON.parse(readFileSync(new URL('./retired-concepts-baseline.json', import.meta.url), 'utf8'));
    const added = newFindings(report.findings, baseline.findings);
    if (added.length) {
      for (const f of added) process.stderr.write(`retired-concepts: [${f.id}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.needle}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`retired-concepts: OK (${report.findings.length} recorded findings at baseline ${baseline.base})\n`);
  } catch (error) {
    process.stderr.write(`retired-concepts: invalid scanner or baseline output: ${error}\n`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
