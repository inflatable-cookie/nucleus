/**
 * Fixture for the backup memory oracle (Spec 028): take one snapshot of a store either
 * through the streaming worker or through the whole-file buffering it replaced, and
 * report this process's own peak resident set size. The parent compares the two peaks,
 * which is the only way to show a snapshot no longer holds the store in memory: the
 * measurement has to be of a process that did nothing else.
 *
 * Usage: node backup-rss.worker.mjs <stream|buffer> <dbPath> <backupDir>
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const [mode, dbPath, backupDir] = process.argv.slice(2);
const baseline = process.resourceUsage().maxRSS;
if (mode === 'buffer') {
  // The shape this task replaced: the whole raw snapshot in memory, then the whole
  // compressed result beside it.
  const dir = join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const stem = new Date().toISOString().replace(/[:.]/g, '-');
  const raw = join(dir, `.${stem}-${randomUUID()}.sqlite`);
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try { source.exec(`VACUUM INTO '${raw.replaceAll("'", "''")}'`); }
  finally { source.close(); }
  writeFileSync(join(dir, `${stem}-${randomUUID()}.hourly.sqlite.gz`), gzipSync(readFileSync(raw)), { mode: 0o600 });
  rmSync(raw, { force: true });
} else {
  const { createBackup } = await import(new URL('../../core/store/backup-worker.mjs', import.meta.url).href);
  await createBackup(dbPath, backupDir);
}
process.stdout.write(JSON.stringify({ mode, baseline, peak: process.resourceUsage().maxRSS }));
