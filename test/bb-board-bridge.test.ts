/**
 * Spec 062, phase 6 acceptance at the plugin backend: the board's forwarding call,
 * BB's lifecycle events as bounded hints, and `bb nucleus terminal`.
 *
 * The production factory (`hosts/bb/plugin/server.ts`) is loaded with a fake
 * `BbPluginApi` whose SDK records every call it receives at any depth, and every
 * registration it makes is exercised. That is what proves the acceptance's
 * negative: no BB settings write, no thread lifecycle-owner write and no terminal
 * read, list, write or close ever leaves the adapter — the terminal command creates
 * one thread-scoped terminal and nothing else, and the task-directory (`host_path`)
 * variant phase 0 refuted does not exist.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import plugin from '../hosts/bb/plugin/server';
import {
  BB_LIFECYCLE_HINTS,
  BOARD_CALL_TIMEOUT_MS,
  TERMINAL_COMMAND,
  boardCallRefusal,
  createBoardBridge,
  forwardLifecycleHint,
  runTerminalCommand,
} from '../hosts/bb/plugin/board-bridge';
import { lifecycleSignalSchema, lifecycleSignalKinds } from '../shared/lifecycle-signal';

type SdkCall = { path: string; args: unknown[] };

/** An SDK stand-in that records every call at any depth and answers each with nothing. */
function recordingSdk(calls: SdkCall[], path: string[] = []): unknown {
  return new Proxy(function sdk() {}, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return recordingSdk(calls, [...path, String(property)]);
    },
    apply(_target, _self, args) {
      const name = path.join('.');
      calls.push({ path: name, args });
      if (name === 'terminals.create') return Promise.resolve({ id: 'term_1' });
      if (name === 'system.version') return Promise.resolve({ currentVersion: '0.49.0' });
      if (name === 'system.uiPreferences.list') return Promise.resolve({ preferences: {} });
      return Promise.resolve(undefined);
    },
  });
}

interface Backend {
  bb: BbPluginApi;
  sdkCalls: SdkCall[];
  settingsCalls: string[];
  rpc: Array<{ methods: string[]; handlers: Record<string, (input?: unknown) => unknown> }>;
  cli: Array<{ name: string; commands: Array<{ name: string; usage?: string }>; run(argv: string[], ctx: Record<string, unknown>): unknown }>;
  events: Map<string, Array<(payload: unknown) => unknown>>;
}

function backend(): Backend {
  const sdkCalls: SdkCall[] = [];
  const settingsCalls: string[] = [];
  const rpc: Backend['rpc'] = [];
  const cli: Backend['cli'] = [];
  const events = new Map<string, Array<(payload: unknown) => unknown>>();
  const kv = new Map<string, unknown>();
  const schema: Record<string, { default?: unknown }> = {};
  const settings = new Proxy({}, {
    get(_target, property) {
      return (...args: unknown[]) => {
        settingsCalls.push(String(property));
        if (property === 'define') {
          Object.assign(schema, args[0]);
          return { get: async () => { settingsCalls.push('get'); return Object.fromEntries(Object.entries(schema).map(([key, entry]) => [key, entry.default])); } };
        }
        return undefined;
      };
    },
  });
  const bb = {
    pluginId: 'nucleus',
    log: { info() {}, warn() {}, error() {}, debug() {} },
    settings,
    storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); }, delete: async (key: string) => { kv.delete(key); } } },
    http: { route() {} },
    rpc: {
      register: (contract: object, handlers: Backend['rpc'][number]['handlers']) => { rpc.push({ methods: Object.keys(contract).sort(), handlers }); },
      experimental_invalidate() {},
      experimental_invalidateAll() {},
    },
    realtime: { publish() {} },
    background: { service() {}, schedule() {} },
    cli: { register: (spec: Backend['cli'][number]) => { cli.push(spec); } },
    agents: { configure: () => ({ tools: [], skills: [] }), registerTool() {} },
    events: { on: (event: string, handler: (payload: unknown) => unknown) => { events.set(event, [...(events.get(event) ?? []), handler]); } },
    providers: {},
    ui: {},
    sdk: recordingSdk(sdkCalls),
    server: { experimental_dataDir: '/synthetic/bb-data' },
    onDispose() {},
  };
  return { bb: bb as unknown as BbPluginApi, sdkCalls, settingsCalls, rpc, cli, events };
}

test('the board call forwards one catalogue method with the BB surface, and refuses what is not a board call', async () => {
  const sent: Array<{ method: string; input: unknown; timeoutMs?: number; via?: string }> = [];
  const bridge = createBoardBridge(() => ({
    request: async (method, input, timeoutMs, via) => { sent.push({ method, input, timeoutMs, via }); return { answered: method }; },
  }));
  assert.deepEqual(await bridge.boardCall({ method: 'queue.ui-snapshot', input: { revision: 3 } }), { answered: 'queue.ui-snapshot' });
  assert.deepEqual(await bridge.boardCall({ method: 'plans', input: {} }), { answered: 'queue.plans' }, 'the shared board alias resolves to the dotted catalogue method');
  assert.deepEqual(sent, [
    { method: 'queue.ui-snapshot', input: { revision: 3 }, timeoutMs: BOARD_CALL_TIMEOUT_MS, via: 'bb' },
    { method: 'queue.plans', input: {}, timeoutMs: BOARD_CALL_TIMEOUT_MS, via: 'bb' },
  ]);
  for (const method of ['service.drain', 'service.lifecycle-signal', 'host.op', 'task.register']) {
    assert.match(String(boardCallRefusal(method)), /not served to the BB board/u, `${method} is refused`);
    await assert.rejects(bridge.boardCall({ method, input: {} }), /not served to the BB board/u);
  }
  await assert.rejects(bridge.boardCall({ method: 'Not A Method', input: {} }));
  assert.equal(sent.length, 2, 'a refused call never reaches the service');
  const offline = createBoardBridge(() => null);
  await assert.rejects(offline.boardCall({ method: 'queue.ui-snapshot', input: {} }), /not connected/u);
});

test("BB's thread events become the existing bounded lifecycle hints, and nothing else", async () => {
  const sent: Array<{ method: string; input: unknown }> = [];
  const source = () => ({ request: async (method: string, input: unknown) => { sent.push({ method, input }); return { ok: true, matched: 0 }; } });
  const at = new Date('2026-11-17T12:00:00.000Z');
  for (const event of Object.keys(BB_LIFECYCLE_HINTS) as Array<keyof typeof BB_LIFECYCLE_HINTS>) {
    await forwardLifecycleHint(source, event, { thread: { id: `thr_${event}`, title: 'not forwarded', environmentId: 'env_1' } as never }, () => at);
  }
  assert.equal(sent.length, Object.keys(BB_LIFECYCLE_HINTS).length);
  for (const { method, input } of sent) {
    assert.equal(method, 'service.lifecycle-signal', 'a hint is the scheduling signal, never an owner verb');
    const parsed = lifecycleSignalSchema.parse(input);
    assert.ok((lifecycleSignalKinds as readonly string[]).includes(parsed.kind));
    assert.deepEqual(Object.keys(input as object).sort(), ['agentId', 'at', 'kind', 'workspaceId'], 'only the kind, the thread id and the time travel');
    assert.equal(parsed.workspaceId, null);
  }
  assert.equal(BB_LIFECYCLE_HINTS['thread.active'], 'agent.turn_started');
  assert.equal(BB_LIFECYCLE_HINTS['interaction.pending'], 'agent.permission_requested');
  // No thread id, or no channel, is no hint; a failed hint is dropped, never retried.
  assert.equal(forwardLifecycleHint(source, 'thread.idle', { thread: null }), null);
  assert.equal(forwardLifecycleHint(() => null, 'thread.idle', { thread: { id: 'thr_1' } }), null);
  await forwardLifecycleHint(() => ({ request: async () => { throw new Error('service away'); } }), 'thread.idle', { thread: { id: 'thr_1' } });
});

test('the terminal command creates one thread-scoped terminal in the calling thread and nothing else', async () => {
  const created: unknown[] = [];
  const sdk = { terminals: { create: async (args: unknown) => { created.push(args); return { id: 'term_9' }; } } };
  const opened = await runTerminalCommand(['terminal', 'nucleus#1297'], { threadId: 'thr_planner', cwd: '/synthetic/task-worktree' } as never, sdk);
  assert.equal(opened.exitCode, 0);
  assert.deepEqual(created, [{ cols: 120, rows: 32, scope: { kind: 'thread', threadId: 'thr_planner' }, start: { mode: 'shell' }, title: 'nucleus#1297' }],
    'a cwd in the calling context never turns the terminal into a task-directory terminal');
  assert.match(String(opened.stdout), /term_9/u);
  const plain = await runTerminalCommand(['terminal'], { threadId: 'thr_planner' }, sdk);
  assert.equal(plain.exitCode, 0);
  assert.equal((created[1] as { title: string }).title, 'Terminal');
  // Without a calling thread there is nothing to own the tab: refused, nothing created.
  const outside = await runTerminalCommand(['terminal'], {}, sdk);
  assert.equal(outside.exitCode, 2);
  // The refuted task-directory variant has no spelling: any option is refused.
  for (const argv of [['terminal', '--cwd', '/synthetic/task'], ['terminal', '--task-dir'], ['terminal', 'a', 'b']]) {
    assert.equal((await runTerminalCommand(argv, { threadId: 'thr_planner' }, sdk)).exitCode, 2, `${argv.join(' ')} is refused`);
  }
  assert.equal(created.length, 2);
  const help = await runTerminalCommand(['terminal', '--help'], { threadId: 'thr_planner' }, sdk);
  assert.equal(help.exitCode, 0);
  assert.equal(created.length, 2, 'help creates nothing');
  // The source carries no host-path terminal at all (phase 0 refuted it).
  assert.doesNotMatch(readFileSync(new URL('../hosts/bb/plugin/board-bridge.ts', import.meta.url), 'utf8'), /kind: "host_path"|kind: 'host_path'/u);
});

test('the backend registers the board call, the hints and the terminal command beside the list, and writes no settings, lifecycle owner or terminal state', async () => {
  const fake = backend();
  await plugin(fake.bb);

  const board = fake.rpc.find(entry => entry.methods.includes('boardCall'));
  assert.ok(board, 'the board forwarding call registers');
  await assert.rejects(board!.handlers.boardCall({ method: 'queue.ui-snapshot', input: {} }) as Promise<unknown>, /not connected/u, 'with no service channel the board call fails closed');
  assert.deepEqual([...fake.events.keys()].sort(), Object.keys(BB_LIFECYCLE_HINTS).sort(), 'every mapped BB event is listened to, and nothing else');
  for (const [event, handlers] of fake.events) for (const handler of handlers) await handler({ thread: { id: `thr_${event}` }, interaction: { id: 'int_1' } });

  assert.equal(fake.cli.length, 1, 'BB takes one CLI registration per plugin');
  const spec = fake.cli[0]!;
  assert.equal(spec.name, 'nucleus');
  const commands = spec.commands.map(command => command.name);
  assert.ok(commands.includes('prefs-list'), "the list's own commands stay");
  assert.equal(commands.filter(name => name === TERMINAL_COMMAND.name).length, 1, 'one terminal command');
  assert.ok(!commands.some(name => /dir|path|cwd/u.test(name)), 'no task-directory terminal command');
  const opened = await spec.run(['terminal'], { threadId: 'thr_planner', cwd: '/synthetic/task-worktree' }) as { exitCode: number };
  assert.equal(opened.exitCode, 0);
  const listed = await spec.run(['prefs', 'list', '--json'], {}) as { exitCode: number; stdout: string };
  assert.equal(listed.exitCode, 0, "argv the terminal does not own still reaches the list's parser");
  assert.ok('expandedTaskGroups' in JSON.parse(listed.stdout));

  // The negative the acceptance names, over everything the factory and its
  // registrations sent to BB.
  const terminalCalls = fake.sdkCalls.filter(call => call.path.startsWith('terminals.'));
  assert.deepEqual(terminalCalls.map(call => call.path), ['terminals.create'], 'one terminal created; none listed, read, written, resized or closed');
  assert.deepEqual((terminalCalls[0]!.args[0] as { scope: unknown }).scope, { kind: 'thread', threadId: 'thr_planner' });
  assert.deepEqual(fake.sdkCalls.filter(call => /settings|uiPreferences\.(set|update|reset|write)/iu.test(call.path)), [], 'no BB settings write');
  assert.deepEqual(fake.settingsCalls.filter(name => name !== 'define' && name !== 'get'), [], "the plugin's own settings are declared and read, never written");
  assert.deepEqual(fake.sdkCalls.filter(call => /lifecycleOwner/u.test(JSON.stringify(call.args))), [], 'no lifecycle-owner write');
  assert.deepEqual(fake.sdkCalls.filter(call => /^threads\.(update|spawn|archive|stop|send)/u.test(call.path)), [], 'no thread write from the board, the hints or the CLI');
});

test("the service's BB adapter never asks the plugin for a terminal read or a lifecycle owner", () => {
  for (const file of ['../service/bb-host.ts', '../hosts/bb/threads.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /"terminal\.(list|close)"|'terminal\.(list|close)'/u, `${file} sends no terminal read or close`);
    assert.doesNotMatch(source, /lifecycleOwner/u, `${file} writes no lifecycle owner`);
  }
});
