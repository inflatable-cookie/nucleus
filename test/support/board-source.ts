/**
 * The board's source text for regex assertions: `client/queue.tsx` followed by
 * every module split out of it (`client/board/**`, `client/task/**`,
 * `client/records/**` and `client/telemetry-parts.tsx`). Assertions keep matching while code moves out
 * of queue.tsx, so a pure move never rewrites them. queue.tsx comes first, so
 * `indexOf` finds its call sites before the moved definitions.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultClient = fileURLToPath(new URL('../../client/', import.meta.url));

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** `client` overrides the client directory, for tests that read a fixture checkout. */
export function boardSource(client = defaultClient): string {
  const files = [join(client, 'queue.tsx'), ...walk(join(client, 'board')), ...walk(join(client, 'task')), ...walk(join(client, 'records')), join(client, 'telemetry-parts.tsx')];
  return files.filter(existsSync).map(file => readFileSync(file, 'utf8')).join('\n');
}
