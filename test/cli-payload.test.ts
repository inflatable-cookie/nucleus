import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reader = new URL('../bin/payload.mjs', import.meta.url).href;
const read = (arg: string | null, input?: string) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `import {readPayload} from ${JSON.stringify(reader)}; try { console.log(JSON.stringify(readPayload(${JSON.stringify(arg)}))) } catch (e) { console.error(e.message); process.exit(2) }`],
  { input: input ?? '', encoding: 'utf8' });

test('a CLI payload comes from stdin with -, from a file path, or is {} when omitted', () => {
  // 2026-09-27: a shared /tmp/pg.json was overwritten between plan.get and plan.set by another session.
  const piped = read('-', '{"repository":"owner/longhorn"}');
  assert.equal(piped.status, 0); assert.deepEqual(JSON.parse(piped.stdout), { repository: 'owner/longhorn' });
  const dir = mkdtempSync(join(tmpdir(), 'nsq-payload-'));
  try {
    writeFileSync(join(dir, 'p.json'), '{"id":"x"}');
    assert.deepEqual(JSON.parse(read(join(dir, 'p.json')).stdout), { id: 'x' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(JSON.parse(read(null, 'ignored').stdout), {}, 'stdin is never read without -');
});

test('CLI self-force authenticates with the ticket credential', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-cli-ticket-'));
  const socketPath = join(dir, 'callback.sock'), ticketPath = join(dir, 'run.json');
  writeFileSync(ticketPath, JSON.stringify({ socketPath, taskId: 'task-1', runId: 'run-1', token: 'ticket-secret' }));
  const server = createServer((request, response) => {
    assert.equal(request.url, '/task-control');
    assert.equal(request.headers.authorization, 'Bearer ticket-secret');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"accepted":true}');
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [new URL('../bin/queue-cli.mjs', import.meta.url).pathname, 'task', '-'], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir(),
          NUCLEUS_TICKET: ticketPath, NUCLEUS_RUN_TOKEN: 'stale-wrong-token' },
      });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ taskId: 'task-1', version: 1, action: 'move', to: 'work', force: true, reason: 'Observed idle' }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { accepted: true });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or malformed stdin payload is refused with a readable message', () => {
  const empty = read('-', '');
  assert.equal(empty.status, 2); assert.match(empty.stderr, /Empty payload on stdin/);
  const bad = read('-', '{"repository":');
  assert.equal(bad.status, 2); assert.match(bad.stderr, /Payload on stdin is not valid JSON/);
});

test('030-3 CLI set_routing refuses a missing operator authorization note before connecting',()=>{
  const run=spawnSync(process.execPath,[new URL('../bin/queue-cli.mjs',import.meta.url).pathname,'task','-'],{input:JSON.stringify({taskId:'task',version:1,action:'set_routing',reason:'Change',preferredProfileId:'strong'}),encoding:'utf8'});
  assert.notEqual(run.status,0);assert.match(run.stderr,/requires a note naming operator authorization/);
});





test('retired worker adoption CLI call names review entry without a stack', () => {
  const run = spawnSync(process.execPath, [new URL('../bin/queue-cli.mjs', import.meta.url).pathname, 'adopt', '-'], {
    input: '{}', encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Worker adoption is retired; use review entry/);
  assert.doesNotMatch(run.stderr, /at file:/);
});

test('CLI schema refusals print one line without a stack', () => {
  const run = spawnSync(process.execPath, [new URL('../bin/queue-cli.mjs', import.meta.url).pathname, 'lead.add', '-'], {
    input: JSON.stringify({ repositories: 1, title: 't' }),
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stderr.trim(), 'repositories: expected owner/name origin or {origin, path} or an array of those');
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test('CLI union schema refusals name the offending field and each accepted shape', () => {
  const run=spawnSync(process.execPath,[new URL('../bin/queue-cli.mjs',import.meta.url).pathname,'project.qa.get','-'],{
    input:JSON.stringify({runId:'qa-run'}),encoding:'utf8',
  });
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/runId: unrecognized key/);
  assert.match(run.stderr,/id: expected string/);
  assert.match(run.stderr,/repository: expected string/);
  assert.doesNotMatch(run.stderr,/Invalid input|\n\s+at /);
});

test('promotion timeout output tells callers to inspect the source or operation before retrying', () => {
  const cli = readFileSync(new URL('../bin/queue-cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /outcome unknown — check \$\{target\} \(or operation <id> with queue\.operation-status\); do not repeat blindly/);
  assert.match(cli, /lead\.get promotedTaskId/);
  assert.match(cli, /papercut\.get taskId/);
});

test('CLI forwards --wait in either position and submits an authorized brief in one request', async () => {
  const { createServer: createSocketServer } = await import('node:net');
  const { createFrameReader, encodeFrame, PROTOCOL_VERSION } = await import('../shared/service/protocol');
  const { rpcContractDigests } = await import('../shared/rpc-contracts');
  const { projectQaRunSchema } = await import('../shared/contracts');
  const dir = mkdtempSync(join(tmpdir(), 'cli-wait-'));
  const socketPath = join(dir, 's');
  const calls: { method: string; input: any }[] = [];
  const run = projectQaRunSchema.parse({ id: 'qa-fixture', key: 'owner/repo', repository: { origin: 'owner/repo', path: dir },
    state: 'failed', baseBranch: 'main', base: 'a'.repeat(40), argv: ['effigy', 'qa'], digest: 'b'.repeat(64),
    exitCode: 1, durationMs: 10, outputTail: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    pid: null, capacityWait: null, capacityUnavailable: false, failureIndexes: [], failuresLogPath: join(dir, 'failures.log') });
  const server = createSocketServer(socket => {
    const reader = createFrameReader((frame: any) => {
      let result: unknown = {};
      if (frame.method === 'caller.resolve') result = {caller: 'nucleus-agent:v1:["paseo-fixture","fixture-planner"]',hostId:'paseo-fixture',source:'host'};
      if (frame.method === 'service.health') result = { protocolVersion: PROTOCOL_VERSION, rpcContracts: rpcContractDigests() };
      else if (!['service.auth','caller.resolve'].includes(frame.method)) {
        calls.push({ method: frame.method, input: frame.input });
        result = frame.method === 'lead.submit' ? { taskId: 'submitted', reference: 'repo#1' } : run;
      }
      socket.write(encodeFrame({ v: PROTOCOL_VERSION, id: frame.id, result }));
    }, error => { throw error; });
    socket.on('data', chunk => reader.feed(chunk));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  writeFileSync(join(dir, 'queue-service.json'), JSON.stringify({ protocolVersion: PROTOCOL_VERSION, buildId: 'fixture-build', socketPath,
    credential: 'a'.repeat(64), pid: process.pid, startedAt: new Date().toISOString() }));
  const invoke = async (args: string[], input: unknown) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [new URL('../bin/queue-cli.mjs', import.meta.url).pathname, ...args], {
      env: { ...process.env, NUCLEUS_DATA_HOME: dir, NUCLEUS_TICKET: '', PASEO_AGENT_ID: 'fixture-planner' },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
  try {
    for (const args of [['project.qa.run', '-', '--wait'], ['project.qa.run', '--wait', '-']]) {
      const result = await invoke(args, { repository: 'owner/repo' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).state, 'failed');
      assert.match(result.stderr, /QA request ID: .*reconcile with project\.qa\.request-status/);
      const call = calls.at(-1)!;
      assert.equal(call.input.wait, true);
      assert.equal(call.input.submitterAgentId, 'nucleus-agent:v1:["paseo-fixture","fixture-planner"]');
      assert.ok(call.input.requestId);
    }
    const result = await invoke(['lead.submit', '-'], { repository: 'owner/repo', title: 'Build it', body: '---\ntitle: Build it\n---\n',
      agent: 'fixture-planner', note: 'Tom authorized the work' });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { taskId: 'submitted', reference: 'repo#1' });
    assert.equal(calls.at(-1)!.method, 'lead.submit');
    assert.equal(calls.at(-1)!.input.note, 'Tom authorized the work');
    assert.equal(calls.length, 3, 'each command makes one mutation request');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
