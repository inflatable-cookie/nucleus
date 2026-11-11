/**
 * Row 7 of the Paseo host split (task 871): agent origin, observation, timeline,
 * stop, archive and the usage stream are reached through `Host`, never through
 * the adapter an owner holds. Overrides and test doubles placed on
 * `resolution.adapter` or `engine.adapter` are still the ones called, because the
 * façade reads the owner's adapter at each call.
 *
 * This is a source inventory. It fails on any `adapter.<method>(` call for these
 * methods outside the Paseo adapter itself and the façade. A presence check
 * (`adapter.<method> ?`) is not a call and stays where it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The Host methods row 7 moves to `Host`; each is reached through the façade. */
const MOVED = ['originAgent', 'observe', 'observationInventory', 'listLiveAgents', 'agentTimelinePage', 'agentTimeline', 'stopAgentTurn', 'archiveAgent', 'subscribeRunUsage'];

/**
 * An `adapter` receiver calling one moved method. The call forms are `adapter.m(`,
 * `adapter.m!(`, `adapter.m?.(`, `adapter?.m(` and the cast `(adapter as X).m(`.
 * A presence check (`adapter.m ?`) is not a call and does not match.
 */
const callOnAdapter = new RegExp(`\\badapter\\b(?:\\s+as\\s+[^)]+\\))?\\??\\.(?:${MOVED.join('|')})(?:!|\\?\\.)?\\(`);

/** The only files that may hold the adapter's own call: the Paseo implementation and the façade over it. */
const exempt = new Set(['core/host/host-facade.ts']);

function serverSources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return serverSources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

test('no owner calls a moved Host method on the adapter; each reaches it through Host', () => {
  const offenders: string[] = [];
  for (const path of ['core', 'service'].flatMap(owner => serverSources(join(root, owner)))) {
    const file = relative(root, path);
    if (exempt.has(file)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (callOnAdapter.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the inventory pattern catches every call form of a moved method on the adapter, and no presence check', () => {
  const calls = [
    'const state = await this.adapter.observe(agentId);',
    'const identity = await this.adapter.originAgent?.(reviewer);',
    'notice = runningShellCommand(await this.resolution.adapter.agentTimeline?.(agentId) ?? null);',
    'await adapter.stopAgentTurn!(run.agentId);',
    'await adapter?.archiveAgent(agentId);',
    'const origin = await (this.adapter as PaseoAdapter).originAgent!(id);',
    'const live = this.engine.adapter.listLiveAgents?.();',
  ];
  const notCalls = [
    'const identity = this.adapter.originAgent ? await this.resolution.host.originAgent(reviewer) : undefined;',
    'if (this.resolution.adapter.agentTimeline) return;',
    'const state = await this.resolution.host.observe(agentId);',
    'const observed = await this.engine.host.observe(agentId);',
  ];
  for (const line of calls) assert.equal(callOnAdapter.test(line), true, `caught: ${line}`);
  for (const line of notCalls) assert.equal(callOnAdapter.test(line), false, `not a call: ${line}`);
});

test('the façade is the one place that reads the adapter for a moved method', () => {
  const facade = readFileSync(join(root, 'core/host/host-facade.ts'), 'utf8');
  for (const method of MOVED) assert.match(facade, new RegExp(`\\b${method}\\b`), `façade carries ${method}`);
});
