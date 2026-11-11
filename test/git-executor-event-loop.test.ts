import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submissionSchema } from '../shared/contracts';
import { QueueService } from '../service/transport/server';
import { ServiceClient } from '../shared/service/client';
import { readServiceInfo } from '../service/transport/identity';
import { assertSocketPathWithinBound, socketFixtureDirectory } from './support/socket-fixture';

/**
 * Falsify against origin/main: this file plus the debug action
 * `ordinary-review-source` on a tree whose `ordinaryReviewSource` still uses
 * `gitSync`. `store.task` then waits the sleep because `execFileSync` holds the
 * executor. The debug action is new, so this file cannot run unmodified there.
 */
const base = 'b'.repeat(40);
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function git(cwd: string, ...args: string[]) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8' }).trim();
}

test('the executor still answers while a slow git status runs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ns-slow-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), checkout = join(root, 'checkout'), bin = join(root, 'bin');
  mkdirSync(bin);
  execFileSync(realGit, ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'test'); git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'remote', 'add', 'origin', 'https://example.test/o/r.git');
  writeFileSync(join(repo, 'a'), 'a\n'); git(repo, 'add', 'a'); git(repo, 'commit', '-qm', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'task', checkout);
  const head = git(checkout, 'rev-parse', 'HEAD');
  writeFileSync(join(bin, 'git'), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--porcelain" ]; then sleep 2; break; fi
done
exec "${realGit}" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const previousPath = process.env.PATH ?? '';
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });

  const dir = socketFixtureDirectory('queue-service.sock');
  const service = new QueueService({ owner: { dataDir: dir, timers: false }, fixture: 'slow-db', fixtureState: {}, debug: true });
  await service.start();
  const info = readServiceInfo(dir)!;
  assertSocketPathWithinBound(info.socketPath);
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  t.after(async () => { await client.close(); await service.stop(); rmSync(dir, { recursive: true, force: true }); });

  const inserted = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
    submissionId: 'slow-git-1', title: 'Git does not block the executor', repoPath: '/fixture', planningCommit: base,
    handoffPath: 'docs/handoffs/slow-git-1.md', originAgentId: 'origin',
  }), 'fixture-host', 'Handoff', base] }) as { id: string };

  const task = {
    workspaceIntent: { id: 'w' },
    directory: checkout,
    branch: 'task',
    baseBranch: 'main',
    repoPath: repo,
  };
  const slow = service.debug({ target: 'fixture', action: 'ordinary-review-source', value: { task, head, detached: false } });
  const started = Date.now();
  const read = await service.debug({ target: 'store', method: 'task', args: [inserted.id] }) as { id: string };
  const readMs = Date.now() - started;
  assert.equal(read.id, inserted.id);
  assert.ok(readMs < 400, `the executor answered store.task in ${readMs} ms while git status slept`);
  await slow;
  assert.ok(Date.now() - started >= 1_500, 'the slow git status actually ran');
});
