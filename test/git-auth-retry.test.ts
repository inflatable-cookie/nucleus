import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryGitSshAuthentication, SshAuthExhaustedError } from '../core/git/git-auth-retry';
import { SSH_AUTH_EXHAUSTED, isSshAuthenticationFailure } from '../shared/ssh-auth';
import { isTransportFailure } from '../shared/transport';

const failure = (stderr = 'git@github.com: Permission denied (publickey).', extras = {}) => Object.assign(new Error(stderr), { code: 128, stderr, stdout: '', ...extras });

for (const operation of ['fetch', 'push', 'ls-remote']) test(`${operation} survives two SSH auth failures without leaving the operation`, async () => {
  const waits: number[] = []; let attempts = 0;
  const result = await retryGitSshAuthentication([operation, 'origin'], async () => {
    if (++attempts < 3) throw failure(); return 'success';
  }, async ms => { waits.push(ms); });
  assert.equal(result, 'success'); assert.equal(attempts, 3); assert.deepEqual(waits, [2000, 5000]);
});

test('persistent SSH auth failure exhausts exactly three attempts and cannot become daemon retry', async () => {
  let attempts = 0;
  await assert.rejects(retryGitSshAuthentication(['fetch', 'origin'], async () => {
    attempts++; throw failure('Error connecting to agent: not connected');
  }, async () => {}), error => {
    assert.ok(error instanceof SshAuthExhaustedError);
    assert.match(error.message, new RegExp(SSH_AUTH_EXHAUSTED));
    assert.equal(isTransportFailure(error), false);
    return true;
  });
  assert.equal(attempts, 3);
});

test('unreadable agent and repository authentication diagnostics are recognized', () => {
  for (const message of ['fatal: Could not read from remote repository.', 'Could not open a connection to your authentication agent.', 'Error connecting to agent: No such file or directory', 'sign_and_send_pubkey: signing failed for ED25519 from agent: agent refused operation', 'SSH_AUTH_SOCK unreadable: Permission denied']) assert.equal(isSshAuthenticationFailure(message), true, message);
  assert.equal(isSshAuthenticationFailure('Permission denied writing .git/index'), false);
  // A missing or inaccessible repository ends with the same generic line but is not a retryable key failure.
  assert.equal(isSshAuthenticationFailure("fatal: '/tmp/missing.git' does not appear to be a git repository\nfatal: Could not read from remote repository."), false);
  assert.equal(isSshAuthenticationFailure('ERROR: Repository not found.\nfatal: Could not read from remote repository.'), false);
});

test('a closed daemon client is classified as transient transport failure', () => {
  assert.equal(isTransportFailure(new Error('Daemon client closed')), true);
});

test('unknown push delivery, remote hook failures, killed commands and local operations are never blindly retried', async () => {
  for (const [args, error] of [
    [['push'], failure('Connection reset by peer')],
    [['push'], failure(undefined, { stdout: 'refs/heads/main accepted' })],
    [['push'], failure('remote: Permission denied (publickey).')],
    [['push'], failure('To first-remote\n main -> main\nPermission denied (publickey).')],
    [['fetch'], failure(undefined, { signal: 'SIGTERM', killed: true })],
    [['fetch'], failure(undefined, { code: 1 })],
    [['commit'], failure()],
    [['clone'], failure()],
  ] as const) {
    let attempts = 0;
    await assert.rejects(retryGitSshAuthentication([...args], async () => { attempts++; throw error; }, async () => {}), error);
    assert.equal(attempts, 1);
  }
});

test('both Git runners apply the authentication retry policy', async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { git } = await import('../core/git/index');
  const { gitRaw } = await import('../core/hooks/hooks');
  const dir = await mkdtemp(join(tmpdir(), 'queue-auth-runner-'));
  const originalPath = process.env.PATH;
  t.after(async () => { process.env.PATH = originalPath; await rm(dir, { recursive: true, force: true }); });
  const counter = join(dir, 'calls');
  await writeFile(join(dir, 'git'), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='rev-parse'){process.stdout.write(${JSON.stringify(dir)});process.exit(0);}const p=${JSON.stringify(counter)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));if(n===0){process.stderr.write('Permission denied (publickey).');process.exit(128);}process.stdout.write('ok');`, { mode: 0o755 });
  process.env.PATH = `${dir}:${originalPath}`;
  assert.equal(await git(dir, 'fetch', 'origin'), 'ok');
  assert.equal(await readFile(counter, 'utf8'), '2');
  await rm(counter);
  const result = await gitRaw(dir, ['push', 'origin']);
  assert.equal(result.code, 0); assert.equal(result.stdout.toString(), 'ok');
  assert.equal(await readFile(counter, 'utf8'), '2');
});
