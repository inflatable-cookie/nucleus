/** Honest process-tree CPU sampling (Tom, 2026-10-23: "Honest + cheaper"): injected reads only, no native probes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROCESS_START_IDENTITY_ENV, LEGACY_PROCESS_START_IDENTITY_ENV, processStartIdentityEnvironment,
  type ProcessStartIdentitySearch,
} from '../core/machine/process-identity-search';
import {
  PROCESS_TREE_FULL_SCAN_MS, PROCESS_TREE_GROUP_READ_MS, ProcessTreeCpuSampler,
  type ProcessTreeCpuReads,
} from '../core/machine/process-tree-cpu';
import {
  darwinProcessReads, parseEnvironmentLines, parseHostProcessLines, parsePsCpuLines,
  type HostProcessLine,
} from '../core/machine/process-host-reads';
import { macStartIdentity } from '../core/machine/start-identity';

const SPAWN = 'Fri Oct 23 10:00:00 2026';
const LATER = 'Fri Oct 23 10:00:05 2026';
const BEFORE = 'Fri Oct 23 09:59:00 2026';
const PGID = 4100;
const leader = macStartIdentity(PGID, SPAWN);
const id = (pid: number, lstart = SPAWN) => macStartIdentity(pid, lstart);
const line = (pid: number, pgid: number, time: string, lstart = SPAWN) => `${String(pid).padStart(5)} ${pgid} ${lstart} ${time}`;
const listing = (...lines: string[]) => `${lines.join('\n')}\n`;
const found = (...processes: Array<[pid: number, pgid: number, lstart?: string]>): ProcessStartIdentitySearch =>
  ({ state: 'found', processes: processes.map(([pid, processGroupId, lstart]) => ({ pid, processGroupId, startIdentity: id(pid, lstart) })) });
const hostLine = (pid: number, ppid: number, pgid: number, lstart = SPAWN): HostProcessLine =>
  ({ pid, ppid, pgid, startIdentity: id(pid, lstart) });

/** Scripted reads: each call takes the next scripted answer, repeating the last. */
function reads(script: {
  platform?: NodeJS.Platform;
  snapshot?: Array<Map<string, number> | null>;
  /** Host-wide listings without environments; absent means an empty host. */
  host?: Array<HostProcessLine[] | null>;
  /** Marker environment answers; absent means nothing carries the marker. */
  env?: ProcessStartIdentitySearch[];
  group?: Array<string | null>;
  pids?: Array<string | null>;
  alive?: (pid: number) => boolean;
}) {
  const calls = { snapshot: 0, host: 0, env: [] as number[][], group: [] as number[], pids: [] as number[][] };
  const clock = { now: 0 };
  const next = <T>(values: T[] | undefined, index: number, fallback: T): T => values?.length ? values[Math.min(index, values.length - 1)] : fallback;
  const io: ProcessTreeCpuReads = {
    platform: script.platform ?? 'darwin',
    now: () => clock.now,
    snapshot: () => next(script.snapshot, calls.snapshot++, null),
    processListing: () => { calls.host++; return next(script.host, calls.host - 1, []); },
    environmentScan: (_identity, pids) => { calls.env.push([...pids]); return next(script.env, calls.env.length - 1, { state: 'absent' }); },
    groupListing: pgid => { calls.group.push(pgid); return next(script.group, calls.group.length - 1, null); },
    pidListing: pids => { calls.pids.push(pids); return next(script.pids, calls.pids.length - 1, null); },
    alive: script.alive ?? (() => true),
  };
  return { io, calls, clock };
}
const grouped = (io: ProcessTreeCpuReads) => {
  const sampler = new ProcessTreeCpuSampler('marker', 250, io);
  sampler.attachGroup({ pgid: PGID, leaderStartIdentity: leader });
  return sampler;
};
/** One timer tick's sample, the way `start()`'s interval takes it. */
const tick = (sampler: ProcessTreeCpuSampler) => (sampler as unknown as { sample(forceGroup?: boolean): void }).sample();

test('a spawn-only sighting and repeated zeros report unknown CPU, never 0', () => {
  const { io } = reads({ host: [[hostLine(PGID, 1, PGID)]], env: [found([PGID, PGID])], group: [listing(line(PGID, PGID, '0:00.00'))] });
  const sampler = grouped(io);
  for (let i = 0; i < 4; i++) assert.deepEqual(sampler.read(), { cpuMs: null, cpuCoverage: 'unobserved' });
  assert.deepEqual(sampler.stop(), { cpuMs: null, cpuCoverage: 'unobserved' });

  const linux = new ProcessTreeCpuSampler('marker', 250, reads({ platform: 'linux', snapshot: [new Map([['7@123', 0]])] }).io);
  assert.deepEqual(linux.read(), { cpuMs: null, cpuCoverage: 'unobserved' }, 'the full-listing path follows the same rule');
});

test('no successful read, or a platform that cannot sample, is unavailable', () => {
  const { io } = reads({ env: [{ state: 'unknown' }], group: [null] });
  assert.deepEqual(grouped(io).read(), { cpuMs: null, cpuCoverage: 'unavailable' });
  const fallback = new ProcessTreeCpuSampler('marker', 250, reads({ snapshot: [null, new Map()] }).io);
  assert.deepEqual(fallback.read(), { cpuMs: null, cpuCoverage: 'unavailable' });
  assert.deepEqual(fallback.read(), { cpuMs: null, cpuCoverage: 'unavailable' }, 'an absent tree is no sighting');
  const other = reads({ platform: 'win32', snapshot: [new Map([['1@x', 500]])] });
  assert.deepEqual(new ProcessTreeCpuSampler('marker', 250, other.io).read(), { cpuMs: null, cpuCoverage: 'unavailable' });
  assert.equal(other.calls.snapshot, 0);
  assert.deepEqual(new ProcessTreeCpuSampler('', 250, reads({ snapshot: [new Map([['1@x', 500]])] }).io).read(),
    { cpuMs: null, cpuCoverage: 'unavailable' });
});

test('a positive first sighting is kept as a lower bound through failed and later empty reads', () => {
  const { io } = reads({ env: [{ state: 'unknown' }], group: [listing(line(PGID, PGID, '0:00.40')), null, null] });
  const sampler = grouped(io);
  assert.deepEqual(sampler.read(), { cpuMs: 400, cpuCoverage: 'sampled' });
  assert.deepEqual(sampler.read(), { cpuMs: 400, cpuCoverage: 'sampled' }, 'a failed read neither zeroes nor adds');
  assert.deepEqual(sampler.stop(), { cpuMs: 400, cpuCoverage: 'sampled' });
});

test('a read failure between samples changes nothing and a later higher value raises the bound', () => {
  const { io } = reads({ env: [{ state: 'unknown' }], group: [
    listing(line(PGID, PGID, '0:00.20')), null, listing(line(PGID, PGID, '0:00.90')),
  ] });
  const sampler = grouped(io);
  assert.equal(sampler.read().cpuMs, 200);
  assert.equal(sampler.read().cpuMs, 200);
  assert.equal(sampler.read().cpuMs, 900, 'cumulative CPU counts once, at its maximum');
});

test('malformed lines, unparseable, decreasing and negative times never add CPU or produce zero', () => {
  assert.deepEqual(parsePsCpuLines(listing('garbage', line(PGID, PGID, 'n/a'), `${PGID} ${PGID} ${SPAWN}`, line(PGID, PGID, '-0:01.00'),
    line(PGID, PGID, '0:00.30'))), [{ pid: PGID, pgid: PGID, startIdentity: leader, cpuMs: 300 }]);
  const { io } = reads({ env: [{ state: 'unknown' }], group: [
    listing(line(PGID, PGID, '0:00.80')), listing(line(PGID, PGID, '0:00.50')), listing('not a ps line', line(PGID, PGID, '1:xx')),
  ] });
  const sampler = grouped(io);
  assert.equal(sampler.read().cpuMs, 800);
  assert.equal(sampler.read().cpuMs, 800, 'a decreasing or reset value keeps the prior bound');
  assert.deepEqual(sampler.read(), { cpuMs: 800, cpuCoverage: 'sampled' });
  const linux = new ProcessTreeCpuSampler('marker', 250, reads({ platform: 'linux', snapshot: [
    new Map([['7@1', -5], ['8@1', Number.NaN], ['9@1', 1.5]]),
  ] }).io);
  assert.deepEqual(linux.read(), { cpuMs: null, cpuCoverage: 'unavailable' }, 'invalid snapshot values are not sightings');
});

test('a reused PID with a different start time is never credited', () => {
  // Escapee path: the PID read shows a new process under the confirmed PID.
  const escapee = 4200;
  const { io, calls } = reads({
    host: [[hostLine(PGID, 1, PGID), hostLine(escapee, PGID, 9999)]],
    env: [found([PGID, PGID], [escapee, 9999])], group: [null],
    pids: [listing(line(escapee, 9999, '0:00.30')), listing(line(escapee, 9999, '0:05.00', LATER))],
  });
  const sampler = grouped(io);
  assert.equal(sampler.read().cpuMs, 300);
  assert.equal(sampler.read().cpuMs, 300, 'the recycled PID adds nothing');
  sampler.read();
  assert.equal(calls.pids.length, 2, 'the recycled identity leaves the known set');
  // Group path after the leader exits: a confirmed PID now with another start time.
  const member = 4101;
  const group = reads({ host: [[hostLine(member, 1, PGID)]], env: [found([member, PGID])],
    group: [listing(line(member, PGID, '0:07.00', LATER))] });
  assert.deepEqual(grouped(group.io).read(), { cpuMs: null, cpuCoverage: 'unavailable' });
});

test('after the leader exits, numeric-pgid members count only once the candidate read confirms them', () => {
  const [a, b] = [4101, 4102];
  const { io, clock } = reads({
    host: [[hostLine(PGID, 1, PGID), hostLine(a, PGID, PGID), hostLine(b, PGID, PGID)]],
    env: [found([PGID, PGID]), found([PGID, PGID], [a, PGID])],
    group: [listing(line(a, PGID, '0:00.40'), line(b, PGID, '0:00.60'))],
  });
  const sampler = grouped(io);
  assert.deepEqual(sampler.read(), { cpuMs: null, cpuCoverage: 'unavailable' }, 'no leader and no confirmation: nothing');
  clock.now = PROCESS_TREE_FULL_SCAN_MS;
  assert.deepEqual(sampler.read(), { cpuMs: 400, cpuCoverage: 'sampled' }, 'only the confirmed member counts');
});

test('while the recorded leader is in the same read, its group members count', () => {
  const { io } = reads({ env: [{ state: 'absent' }],
    group: [listing(line(PGID, PGID, '0:00.10'), line(4101, PGID, '0:00.25'), line(4102, PGID, '0:00.05', BEFORE))] });
  assert.deepEqual(grouped(io).read(), { cpuMs: 350, cpuCoverage: 'sampled' }, 'a line started before the spawn never counts');
});

test('an empty group read is unknown, not a zero', () => {
  const { io } = reads({ env: [found([PGID, PGID])], group: [null, listing('')] });
  const sampler = grouped(io);
  assert.deepEqual(sampler.read(), { cpuMs: null, cpuCoverage: 'unavailable' });
  assert.deepEqual(sampler.read(), { cpuMs: null, cpuCoverage: 'unavailable' });
  const empty = darwinProcessReads(() => ({ pid: 1, output: [], stdout: '  \n', stderr: '', status: 0, signal: null }));
  assert.equal(empty.groupListing(PGID), null);
});

test('a reused group number with another leader adds nothing', () => {
  const { io } = reads({ env: [{ state: 'absent' }],
    group: [listing(line(PGID, PGID, '0:09.00', LATER), line(4101, PGID, '0:04.00', LATER))] });
  assert.deepEqual(grouped(io).read(), { cpuMs: null, cpuCoverage: 'unavailable' });
});

test('escapees are found by the candidate read, re-read by PID, and counted once across all three sources', () => {
  const escapee = 4300;
  const { io, calls, clock } = reads({
    host: [[hostLine(PGID, 1, PGID), hostLine(escapee, PGID, 4300)]],
    env: [found([PGID, PGID], [escapee, 4300]), found([PGID, PGID], [escapee, PGID]), found([PGID, PGID], [escapee, 4300])],
    group: [
      listing(line(PGID, PGID, '0:00.10')),
      listing(line(PGID, PGID, '0:00.20'), line(escapee, PGID, '0:00.50')),
      listing(line(PGID, PGID, '0:00.20')),
    ],
    pids: [listing(line(escapee, 4300, '0:00.30')), listing(line(escapee, 4300, '0:00.40'))],
  });
  const sampler = grouped(io);
  assert.deepEqual(sampler.read(), { cpuMs: 400, cpuCoverage: 'sampled' }, 'leader 100 + escapee 300');
  assert.deepEqual(calls.pids, [[escapee]]);
  clock.now = PROCESS_TREE_FULL_SCAN_MS;
  assert.deepEqual(sampler.read(), { cpuMs: 700, cpuCoverage: 'sampled' }, 'rejoined: leader 200 + member 500, counted once');
  assert.equal(calls.pids.length, 1, 'an identity seen in the group read is not re-read by PID');
  clock.now = 2 * PROCESS_TREE_FULL_SCAN_MS;
  assert.deepEqual(sampler.read(), { cpuMs: 700, cpuCoverage: 'sampled' }, 'left again: its lower 400 does not lower or double the bound');
  assert.deepEqual(calls.pids, [[escapee], [escapee]]);
});

test('an escapee whose PID is gone is dropped from the known set before any read', () => {
  const escapee = 4300;
  let alive = true;
  const { io, calls } = reads({ host: [[hostLine(PGID, 1, PGID), hostLine(escapee, PGID, 4300)]],
    env: [found([PGID, PGID], [escapee, 4300])], group: [listing(line(PGID, PGID, '0:00.10'))],
    pids: [listing(line(escapee, 4300, '0:00.30'))], alive: () => alive });
  const sampler = grouped(io);
  sampler.read();
  alive = false;
  sampler.read();
  sampler.read();
  assert.equal(calls.pids.length, 1);
});

test('a group line naming another pgid is ignored, even for a confirmed identity', () => {
  const member = 4101;
  const { io } = reads({ host: [[hostLine(member, 1, PGID)]], env: [found([member, PGID])],
    group: [listing(line(PGID, 7777, '0:01.00'), line(member, 7777, '0:02.00'))] });
  assert.deepEqual(grouped(io).read(), { cpuMs: null, cpuCoverage: 'unavailable' });
});

test('legacy-mode output that ignores -g fails closed: other groups never count', () => {
  const others = listing(line(1, 1, '9:00.00', BEFORE), line(321, 321, '1:00.00', LATER), line(4101, 555, '0:30.00', LATER));
  assert.deepEqual(grouped(reads({ env: [found([4101, 555])], group: [others] }).io).read(), { cpuMs: null, cpuCoverage: 'unavailable' });
  const mixed = grouped(reads({ env: [{ state: 'absent' }], group: [`${others}${line(PGID, PGID, '0:00.70')}\n`] }).io);
  assert.deepEqual(mixed.read(), { cpuMs: 700, cpuCoverage: 'sampled' }, 'only the matching group counts');
});

test('the Darwin reads use deterministic argv and set COMMAND_MODE only on the group read', () => {
  const before = process.env.COMMAND_MODE;
  const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }> = [];
  const listings = darwinProcessReads((command, args, options) => {
    assert.equal(command, 'ps');
    seen.push({ args, env: options.env!, timeout: options.timeout, maxBuffer: options.maxBuffer });
    return { pid: 1, output: [], stdout: line(PGID, PGID, '0:00.10'), stderr: '', status: 0, signal: null };
  });
  assert.ok(listings.groupListing(PGID));
  assert.ok(listings.pidListing([4300, 4301]));
  assert.deepEqual(seen.map(call => call.args), [
    ['-ww', '-g', String(PGID), '-o', 'pid=,pgid=,lstart=,time='],
    ['-ww', '-p', '4300,4301', '-o', 'pid=,pgid=,lstart=,time='],
  ]);
  assert.deepEqual([seen[0].env.LC_ALL, seen[0].env.TZ, seen[0].env.COMMAND_MODE], ['C', 'UTC', 'unix2003']);
  assert.deepEqual([seen[1].env.LC_ALL, seen[1].env.TZ, seen[1].env.COMMAND_MODE], ['C', 'UTC', before]);
  assert.deepEqual(seen.map(call => [call.timeout, call.maxBuffer]), [[1_000, 1024 * 1024], [1_000, 1024 * 1024]]);
  assert.equal(process.env.COMMAND_MODE, before, 'the worker env is untouched');
  for (const failed of [
    { status: 1, signal: null, stdout: line(PGID, PGID, '0:00.10') },
    { status: null, signal: 'SIGTERM' as NodeJS.Signals, stdout: line(PGID, PGID, '0:00.10') },
    { status: 0, signal: null, stdout: line(PGID, PGID, '0:00.10'), error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { status: 0, signal: null, stdout: '' },
  ]) {
    const read = darwinProcessReads(() => ({ pid: 1, output: [], stderr: '', ...failed }));
    assert.equal(read.groupListing(PGID), null);
    assert.equal(read.pidListing([1]), null);
  }
});

test('the candidate read lists the host without environments, then reads environments only for those pids', () => {
  const seen: Array<{ args: string[]; maxBuffer?: number }> = [];
  const reads = darwinProcessReads((command, args, options) => {
    assert.equal(command, 'ps');
    seen.push({ args, maxBuffer: options.maxBuffer });
    return {
      pid: 1, output: [], stderr: '', status: 0, signal: null,
      stdout: args.includes('-E')
        ? ` 4300 4300 ${SPAWN} /bin/sh -c NORTHSTAR_QUEUE_PROCESS_START_IDENTITY=marker\n 4301 4301 ${SPAWN} /bin/sh -c other\n`
        : ` 4300 4100 4300 ${SPAWN}\n 4301 1 4301 ${SPAWN}\n`,
    };
  });
  assert.deepEqual(reads.processListing(), [
    { pid: 4300, ppid: 4100, pgid: 4300, startIdentity: id(4300) },
    { pid: 4301, ppid: 1, pgid: 4301, startIdentity: id(4301) },
  ]);
  assert.deepEqual(reads.environmentScan('marker', [4300, 4301]),
    { state: 'found', processes: [{ pid: 4300, processGroupId: 4300, startIdentity: id(4300) }] },
    'a candidate without the marker is not an owned process');
  assert.deepEqual(seen.map(call => call.args), [
    ['-ww', '-A', '-o', 'pid=,ppid=,pgid=,lstart='],
    ['-E', '-ww', '-p', '4300,4301', '-o', 'pid=,pgid=,lstart=,command='],
  ]);
  assert.ok(!seen[0].args.includes('-E'), 'the host-wide listing never reads environments');
  assert.deepEqual(reads.environmentScan('marker', []), { state: 'absent' });
  const failed = darwinProcessReads(() => ({ pid: 1, output: [], stderr: '', status: 1, signal: null, stdout: '' }));
  assert.equal(failed.processListing(), null);
  assert.deepEqual(failed.environmentScan('marker', [4300]), { state: 'unknown' });
  assert.deepEqual(parseHostProcessLines('garbage\n'), []);
  assert.deepEqual(parseEnvironmentLines('garbage\n', 'marker'), []);
});

test('the host-wide read and the group read each keep their own cadence, never a catch-up burst', () => {
  const { io, calls, clock } = reads({ host: [[hostLine(PGID, 1, PGID)]], env: [found([PGID, PGID])],
    group: [listing(line(PGID, PGID, '0:00.10'))] });
  const sampler = grouped(io);
  for (let at = 0; at <= 10_000; at += sampler.intervalMs) { clock.now = at; tick(sampler); }
  assert.equal(calls.host, 3, 'one host-wide listing at 0, 5000 and 10000 ms');
  assert.equal(calls.env.length, 3, 'one environment read per host-wide listing');
  assert.equal(calls.group.length, 11, 'one group read per second');
  const delayed = reads({ host: [[hostLine(PGID, 1, PGID)]], group: [listing(line(PGID, PGID, '0:00.10'))] });
  const late = grouped(delayed.io);
  for (const at of [0, 1700, 1800, 2700, 2900]) { delayed.clock.now = at; tick(late); }
  assert.equal(delayed.calls.host, 1, 'a delayed tick is one later sample, not a catch-up');
  assert.equal(delayed.calls.group.length, 3, 'group reads at 0, 1800 and 2900 ms');
});

test('a caller reading mid-window re-reads the group but not the whole host', () => {
  const { io, calls } = reads({ host: [[hostLine(PGID, 1, PGID)]], group: [listing(line(PGID, PGID, '0:00.10'))] });
  const sampler = grouped(io);
  for (let i = 0; i < 5; i++) sampler.read();
  assert.equal(calls.host, 1, 'five reads at one instant are one host-wide read');
  assert.equal(calls.group.length, 5, 'each read still samples the run own group');
});

test('the environment read covers only the run own candidates, never the whole host', () => {
  const member = 4101, escapee = 4300;
  const foreign = [5001, 5002, 5003].map(pid => hostLine(pid, 1, pid));
  const { io, calls } = reads({
    host: [[hostLine(PGID, 1, PGID), hostLine(member, PGID, PGID), hostLine(escapee, PGID, 4300), ...foreign]],
    env: [found([PGID, PGID], [escapee, 4300])],
    group: [listing(line(PGID, PGID, '0:00.10'), line(member, PGID, '0:00.20'))],
  });
  grouped(io).read();
  assert.deepEqual(calls.env, [[PGID, member, escapee].sort((a, b) => a - b)],
    'the run group, its member and the child that left it; no unrelated process is read or credited');
});

test('an unreadable host listing or environment read proves nothing and lowers nothing', () => {
  const { io, calls } = reads({ host: [null], group: [listing(line(4101, PGID, '0:04.00'))] });
  assert.deepEqual(grouped(io).read(), { cpuMs: null, cpuCoverage: 'unavailable' }, 'an unconfirmed member of a gone leader is not credited');
  assert.deepEqual(calls.env, [], 'no environment read follows a failed listing');
  const unreadable = reads({ host: [[hostLine(4101, 1, PGID)]], env: [{ state: 'unknown' }], group: [listing(line(4101, PGID, '0:04.00'))] });
  assert.deepEqual(grouped(unreadable.io).read(), { cpuMs: null, cpuCoverage: 'unavailable' });
});

test('the marker scan runs at start and then by elapsed time, never as a catch-up burst', () => {
  const { io, calls, clock } = reads({ host: [[hostLine(PGID, 1, PGID)]], env: [found([PGID, PGID])],
    group: [listing(line(PGID, PGID, '0:00.10'))] });
  const sampler = grouped(io);
  for (const at of [0, 250, 500, 750, 1000, 1250, 1999, 2000]) { clock.now = at; sampler.read(); }
  assert.equal(calls.host, 1, 'one host listing inside the first scan window');
  assert.equal(calls.group.length, 8, 'one group read per sample');
});

test('an unprovable leader identity keeps the full-listing path', () => {
  const { io, calls } = reads({ snapshot: [new Map([[id(PGID), 250]])] });
  const sampler = new ProcessTreeCpuSampler('marker', 250, io);
  sampler.attachGroup({ pgid: PGID, leaderStartIdentity: `${PGID}@unknown` });
  assert.deepEqual(sampler.read(), { cpuMs: 250, cpuCoverage: 'sampled' });
  assert.deepEqual([calls.snapshot, calls.group.length], [1, 0]);
});

test('the whole-listing path samples on its own cadence, not on every tick', () => {
  const { io, calls, clock } = reads({ platform: 'linux', snapshot: [new Map([['7@1', 400]])] });
  const sampler = new ProcessTreeCpuSampler('marker', 100, io);
  for (let at = 0; at <= 10_000; at += 100) { clock.now = at; tick(sampler); }
  assert.equal(calls.snapshot, 3, 'one whole-listing read at 0, 5000 and 10000 ms');
  assert.deepEqual(sampler.read(), { cpuMs: 400, cpuCoverage: 'sampled' }, 'the bound is unchanged by the fewer reads');
  assert.equal(PROCESS_TREE_GROUP_READ_MS, 1_000);
});


test('new identity launches set only the Nucleus name and the retained marker still reads', () => {
  assert.deepEqual(processStartIdentityEnvironment('marker'), {
    NUCLEUS_QUEUE_PROCESS_START_IDENTITY: 'marker',
  });
  // The retained NORTHSTAR_ marker is read, never written: a process group
  // recorded before Nucleus (or an escaped descendant of one) still proves.
  for (const names of [[PROCESS_START_IDENTITY_ENV], [LEGACY_PROCESS_START_IDENTITY_ENV],
    [PROCESS_START_IDENTITY_ENV, LEGACY_PROCESS_START_IDENTITY_ENV]]) {
    const candidate = darwinProcessReads(() => ({
      pid: 1, output: [], stderr: '', status: 0, signal: null,
      stdout: ` 4300 4300 ${SPAWN} /bin/sh ${names.map(name => `${name}=marker`).join(' ')}\n`,
    }));
    assert.deepEqual(candidate.environmentScan('marker', [4300]), {
      state: 'found', processes: [{ pid: 4300, processGroupId: 4300, startIdentity: id(4300) }],
    });
  }
});
