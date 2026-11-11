/**
 * Count the child processes a repository call spawns, without touching the
 * operator's host: a private PATH whose shims record their own name and then
 * exec the real tool. Used by task 434's before/after measurements of expensive
 * reads (performance audit 2026-10-25, items A3 and the manifest cache).
 */
import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const SPAWNED_TOOLS = ['git', 'ps', 'lsof'] as const;
export type SpawnedTool = (typeof SPAWNED_TOOLS)[number];

export async function spawnLog(root: string, tools: readonly SpawnedTool[] = SPAWNED_TOOLS,
  resetWrite: (path: string) => Promise<void> = path => writeFile(path, '')) {
  const original = process.env.PATH ?? '';
  const bin = join(root, 'spawn-bin'), log = join(root, 'spawns.log');
  await mkdir(bin, { recursive: true });
  await writeFile(log, '');
  const which = (name: string) => {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env: { ...process.env, PATH: original } });
    return found.status === 0 ? found.stdout.trim() : null;
  };
  const installed: SpawnedTool[] = [];
  for (const name of tools) {
    const real = which(name);
    if (!real) continue;
    const shim = join(bin, name);
    await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' ${name} >> "$NS_SPAWN_LOG"\nexec ${real} "$@"\n`);
    await chmod(shim, 0o755);
    installed.push(name);
  }
  const previous = { PATH: process.env.PATH, NS_SPAWN_LOG: process.env.NS_SPAWN_LOG };
  process.env.PATH = `${bin}:${original}`;
  process.env.NS_SPAWN_LOG = log;
  return {
    /** The tools this host actually has; a missing one is never counted. */
    installed,
    log,
    reset: () => resetWrite(log),
    counts: (): Record<SpawnedTool, number> => {
      const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      return Object.fromEntries(tools.map(name => [name, lines.filter(line => line === name).length])) as Record<SpawnedTool, number>;
    },
    restore: () => {
      process.env.PATH = previous.PATH;
      if (previous.NS_SPAWN_LOG === undefined) delete process.env.NS_SPAWN_LOG;
      else process.env.NS_SPAWN_LOG = previous.NS_SPAWN_LOG;
    },
  };
}
