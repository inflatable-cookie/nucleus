import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Current runtime owners from the layout contract. */
export function runtimeSourceRoots(root: string): string[] {
  const layout = readFileSync(join(root, 'docs/knowledge/contracts/repository-layout.md'), 'utf8');
  const runtime = layout.split('## Target runtime layout')[1]!.split('## Supporting layout')[0]!;
  const roots = [...runtime.matchAll(/^\| `([^`/]+)\/` \|/gm)].map(match => match[1]!);
  assert.ok(roots.length > 0, 'layout contract must name runtime roots');
  return [...new Set(roots)];
}
