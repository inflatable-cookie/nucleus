import { test } from 'node:test';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';

test('measure a terminal workspace archive fixture', async t => {
  const f = await terminalArchiveFixture(t);
  const timings: Array<[string, number]> = [];
  const marks = new Map<string, number>();
  const wrap = (object: any, name: string) => {
    const original = object[name].bind(object);
    object[name] = async (...args: any[]) => {
      const start = performance.now();
      marks.set(`${name}:start`, start);
      try { return await original(...args); }
      finally { const end = performance.now(); marks.set(`${name}:end`, end); timings.push([name, end - start]); }
    };
  };
  wrap(f.retirement, 'capture');
  wrap(f.retirement, 'archived');
  wrap((f.engine as any).hooks, 'finished');
  wrap((f.engine as any).hooks, 'retentionGate');
  const adapter = (f.engine as any).lifecycle.adapter;
  const archive = adapter.archiveTaskWorkspace.bind(adapter);
  const intentTimes: number[] = [];
  const originalRef = f.api.workspaces.ref;
  f.api.workspaces.ref = () => {
    const workspace = originalRef();
    wrap(workspace, 'refresh');
    wrap(workspace, 'archive');
    return workspace;
  };
  adapter.archiveTaskWorkspace = async (...args: any[]) => {
    const allowed = args[4];
    args[4] = () => { const result = allowed(); if (result) intentTimes.push(performance.now()); return result; };
    const build = args[10];
    if (build) {
      const begin = build.begin.bind(build), observed = build.observed.bind(build);
      let buildStart = 0;
      build.begin = () => { buildStart = performance.now(); marks.set('build:start', buildStart); return begin(); };
      build.observed = (result: unknown) => { const end = performance.now(); marks.set('build:end', end); timings.push(['build output', end - buildStart]); return observed(result); };
    }
    const start = performance.now();
    marks.set('adapter:start', start);
    try { return await archive(...args); }
    finally { const end = performance.now(); marks.set('adapter:end', end); timings.push(['workspace adapter', end - start]); }
  };
  const started = performance.now();
  await f.retry();
  timings.push(['total', performance.now() - started]);
  const span = (name: string, a?: number, b?: number) => { if (a !== undefined && b !== undefined) timings.push([name, b - a]); };
  span('host sweep and sibling/catalog work', marks.get('finished:end'), marks.get('capture:start'));
  span('initial proof', marks.get('adapter:start'), marks.get('build:start'));
  span('pre-archive reproof', marks.get('build:end'), intentTimes[0]);
  span('post-intent reproof', intentTimes[0], intentTimes[1]);
  span('local teardown', intentTimes[1], marks.get('adapter:end'));
  console.log('cleanup fixture milliseconds:', timings.map(([name, ms]) => `${name}=${ms.toFixed(1)}`).join(', '),
    `intent gap=${intentTimes.length > 1 ? (intentTimes[1]! - intentTimes[0]!).toFixed(1) : 'unavailable'}ms`);
});
