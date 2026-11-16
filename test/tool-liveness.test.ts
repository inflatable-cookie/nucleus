import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveToolIssue, workspaceToolProcessIssue, type TimelineEntry } from '../core/recovery/stall';

const command = "python3 - <<'PY'\nfrom pathlib import Path\np=Path('/tmp/effigy151-run-integration-validation.py')\nPY";
const call = (status: string | undefined, timestamp: string, turnId: string, extra: Record<string, unknown> = {}): TimelineEntry =>
  ({ timestamp, turnId, item: { type: 'tool_call', name: 'shell', callId: 'exec-c35659f7-236d-4b53-bdfb-9904f1045362', status, detail: { type: 'shell', command }, ...extra } });
// The real effigy#151 owner pair: running in one turn, completed in the next.
const running = call('running', '2026-10-13T21:05:00.800Z', 'codex-turn-393');
const completed = call('completed', '2026-10-13T21:09:57.249Z', 'codex-turn-394');

test('a later terminal state of the same call settles its earlier running entry, in either page order', () => {
  assert.equal(liveToolIssue([running, completed]), null);
  assert.equal(liveToolIssue([completed, running]), null);
  for (const status of ['failed', 'canceled', 'cancelled']) assert.equal(liveToolIssue([running, call(status, completed.timestamp, 'codex-turn-394')]), null, status);
  // A terminal call with no renderer type stays settled (PR #438).
  assert.equal(liveToolIssue([{ timestamp: completed.timestamp, item: { type: 'tool_call', name: 'web_search', callId: 'exec-search', status: 'completed' } }]), null);
});

test('a latest running, status-less, conflicting, ambiguous or unidentified call still refuses', () => {
  assert.match(liveToolIssue([running])!, /is running/);
  assert.match(liveToolIssue([completed, call('running', '2026-10-13T21:12:00.000Z', 'codex-turn-395')])!, /is running/, 'a later running state is live');
  assert.match(liveToolIssue([running, call(undefined, completed.timestamp, 'codex-turn-394')])!, /without a terminal status/);
  assert.match(liveToolIssue([running, call('completed', completed.timestamp, 'codex-turn-394', { detail: { type: 'shell', command: 'git push' } })])!, /conflicting tool or command/);
  assert.match(liveToolIssue([running, call('completed', completed.timestamp, 'codex-turn-394', { name: 'web_search' })])!, /conflicting tool or command/);
  assert.match(liveToolIssue([call('running', completed.timestamp, 'codex-turn-394'), completed])!, /ambiguous states at one instant/);
  // The same command under a different call ID is a different call.
  assert.match(liveToolIssue([completed, call('running', running.timestamp, 'codex-turn-393', { callId: 'exec-other' })])!, /is running/);
  assert.match(liveToolIssue([completed, call('completed', completed.timestamp, 'codex-turn-394', { callId: undefined })])!, /incomplete identity or time/);
  assert.match(liveToolIssue([completed, call('completed', 'not-a-time', 'codex-turn-394', { callId: 'exec-y' })])!, /incomplete identity or time/);
});

// effigy#524: Codex left the parent's `[Sub-agent]` call running after the turn
// that started it completed, so the author read as holding an owned tool for
// ever. A call that cannot outlive its turn is settled by the agent's own
// observation, and nothing else changes.
const idleAgent = { status: 'idle', active: false, activeTurnId: null, permissions: false };
const turnCall = (status: string | undefined, timestamp: string, turnId = 'codex-turn-8', extra: Record<string, unknown> = {}): TimelineEntry =>
  ({ timestamp, turnId, item: { type: 'tool_call', name: 'Sub-agent', callId: 'call-sub-agent', status, detail: { type: 'sub_agent', description: 'Review the diff', log: '' }, ...extra } });
const turnEnded: TimelineEntry = { timestamp: '2026-11-02T10:05:00.000Z', turnId: 'codex-turn-9', item: { type: 'assistant_message', text: 'done' } };
const subAgentRunning = turnCall('running', '2026-11-02T10:00:00.000Z');

test('finished owner settles mismatched terminal call identities', () => {
  const changed = call('completed', completed.timestamp, 'codex-turn-394', { name: 'Bash', detail: { type: 'shell', command: 'git status' } });
  assert.equal(liveToolIssue([running, changed], idleAgent), null);
  assert.match(liveToolIssue([running, changed], { ...idleAgent, active: true })!, /conflicting/);
  const stillRunning = { ...changed, item: { ...changed.item, status: 'running' } };
  assert.match(liveToolIssue([running, stillRunning], idleAgent)!, /conflicting|running/);
});

test('a sub-agent call left running by a turn that has since completed is settled on an idle agent', () => {
  // Without the agent's own turn proof the running entry still holds.
  assert.match(liveToolIssue([subAgentRunning])!, /observed tool Sub-agent \(sub_agent\) is running/);
  assert.match(liveToolIssue([subAgentRunning], null)!, /observed tool Sub-agent \(sub_agent\) is running/);
  // The turn that started the call is over: `active: false` with the positively
  // reported `activeTurnId: null` settles a kind bound to its turn — with or
  // without a later turn's entries.
  assert.equal(liveToolIssue([subAgentRunning], idleAgent), null);
  assert.equal(liveToolIssue([subAgentRunning, turnEnded], idleAgent), null);
  // Every finished-session status and every ordering of the same page agree.
  for (const status of ['idle', 'error', 'closed']) assert.equal(liveToolIssue([turnEnded, subAgentRunning], { ...idleAgent, status }), null, status);
  for (const kind of ['read', 'edit', 'write', 'search', 'fetch', 'plain_text', 'plan']) {
    const entry = turnCall('running', subAgentRunning.timestamp, 'codex-turn-8', { detail: { type: kind } });
    assert.equal(liveToolIssue([entry], idleAgent), null, kind);
  }
});

test('the same call stays live while its turn is live, permissioned or unprovable', () => {
  for (const owner of [
    { ...idleAgent, active: true },
    { ...idleAgent, activeTurnId: 'codex-turn-8' },
    { ...idleAgent, permissions: true },
    { ...idleAgent, status: 'running' },
    { ...idleAgent, status: 'active' },
    // An observation missing any turn fact is unknown, never a settled turn:
    // only the positive `activeTurnId: null` proves no turn is live.
    { ...idleAgent, activeTurnId: undefined },
    { ...idleAgent, active: undefined },
    { ...idleAgent, permissions: undefined },
    { ...idleAgent, status: undefined },
    { status: 'idle' },
  ]) assert.match(liveToolIssue([subAgentRunning], owner)!, /is running/, JSON.stringify(owner));
  // A live call in an active turn is never a leftover of a finished one.
  assert.match(liveToolIssue([turnEnded, turnCall('running', turnEnded.timestamp, 'codex-turn-9')], { ...idleAgent, active: true })!, /is running/);
});

test('a background shell, a worktree setup and an unknown kind keep the fence from an earlier turn', () => {
  const shell = turnCall('running', subAgentRunning.timestamp, 'codex-turn-8', { name: 'Bash', detail: { type: 'shell', command: 'effigy qa' } });
  assert.match(liveToolIssue([shell, turnEnded], idleAgent)!, /observed tool Bash \(shell\) is running/, 'a background shell outlives its turn and the refusal names its kind');
  const setup = turnCall('running', subAgentRunning.timestamp, 'codex-turn-8', { name: 'Worktree setup', detail: { type: 'worktree_setup', worktreePath: '/w', branchName: 'b', log: '', commands: [] } });
  assert.match(liveToolIssue([setup, turnEnded], idleAgent)!, /is running/, 'a setup command is a detached process');
  for (const detail of [{ type: 'unknown', input: {}, output: {} }, undefined]) {
    const entry = turnCall('running', subAgentRunning.timestamp, 'codex-turn-8', detail === undefined ? { detail: undefined } : { detail });
    assert.match(liveToolIssue([entry, turnEnded], idleAgent)!, /is running/, `an unrecognised kind keeps the fence (${JSON.stringify(detail)})`);
  }
});

test('a finished-turn shell settles only after a complete no-process proof', () => {
  const workspace = '/work/task';
  const ownRun = '123e4567-e89b-42d3-a456-426614174000';
  const otherRun = '223e4567-e89b-42d3-a456-426614174001';
  const empty: Array<{ pid: number; ppid?: number | null; command: string; cwd: string | null }> = [];
  const report = (pid: number, ppid: number, ticket: string, cwd: string) => ({
    pid, ppid, command: `node /plugin/mcp-report.mjs ${ticket} report`, cwd,
  });
  assert.equal(workspaceToolProcessIssue(empty, workspace, [ownRun]), null, 'idle pi with no provider process and no workspace process is clear');
  assert.match(workspaceToolProcessIssue([{ pid: 7, ppid: 1, command: 'bash -lc build', cwd: workspace }], workspace, [ownRun])!, /remains in the task workspace process tree/);
  assert.match(workspaceToolProcessIssue([{ pid: 8, ppid: 7, command: 'child', cwd: '/other' }, { pid: 7, ppid: 1, command: 'bash', cwd: workspace }], workspace, [ownRun])!, /remains in the task workspace process tree/);
  assert.equal(workspaceToolProcessIssue([report(9, 1, `/fixture/tickets/mcp-${otherRun}.json`, '/other')], workspace, [ownRun]), null,
    'another run helper outside the task workspace does not block this participant');
  assert.match(workspaceToolProcessIssue([report(10, 1, `/fixture/tickets/mcp-${otherRun}.json`, workspace)], workspace, [ownRun])!, /remains in the task workspace process tree/,
    'a foreign ticket helper inside the task workspace still blocks');
  assert.match(workspaceToolProcessIssue([
    { pid: 11, ppid: 7, command: 'pi child', cwd: workspace },
    report(12, 11, `/fixture/tickets/mcp-${otherRun}.json`, '/other'),
  ], workspace, [ownRun])!, /remains in the task workspace process tree/,
  'a foreign helper descended from a workspace process still blocks');
  assert.match(workspaceToolProcessIssue([report(13, 1, `/fixture/tickets/mcp-${ownRun}.json`, '/other')], workspace, [ownRun])!, /still carries the run MCP ticket/,
    'this participant’s own helper blocks even when its cwd is elsewhere');
  assert.match(workspaceToolProcessIssue([report(14, 1, '/fixture/tickets/mcp-123e4567-e89b-42d3.json', workspace)], workspace, [ownRun])!, /unreadable or truncated MCP ticket identity/,
    'a truncated helper ticket in the workspace remains unknown');
  assert.equal(workspaceToolProcessIssue([report(15, 1, '/fixture/tickets/mcp-123e4567-e89b-42d3.json', '/other')], workspace, [ownRun]), null,
    'a truncated helper outside the task workspace is scoped out');
  assert.match(workspaceToolProcessIssue([{ pid: 16, ppid: 7, state: 'S', command: 'worker', cwd: null }, { pid: 7, ppid: 1, state: 'S', command: 'bash', cwd: workspace }], workspace, [ownRun])!, /unreadable working directory/,
    'an unreadable cwd whose parent is in the task tree is unknown');
  assert.equal(workspaceToolProcessIssue([{ pid: 16, ppid: 1, state: 'S', command: 'worker', cwd: null }], workspace, [ownRun]), null,
    'an unreadable cwd whose known parent is unrelated is ignored');
  assert.match(workspaceToolProcessIssue([{ pid: 17, command: 'worker', cwd: '/other' }], workspace, [ownRun])!, /unreadable parent identity/);
});

// Nucleus #1259: PID 203 in the swallowtail report is a `<defunct>` zombie
// child of the Paseo daemon, unrelated to either task. Zombies hold no tools
// and are never judged, whatever else about them is unreadable.
test('a zombie child of an unrelated parent never blocks the owned-tool proof', () => {
  const workspace = '/work/task';
  const ownRun = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(workspaceToolProcessIssue(
    [{ pid: 203, ppid: 16365, state: 'Z', command: '<defunct>', cwd: null }], workspace, [ownRun]), null,
    'the swallowtail zombie shape clears');
  // A zombie inside the task tree still holds nothing: the live tree process keeps its own refusal.
  assert.match(workspaceToolProcessIssue([
    { pid: 7, ppid: 1, state: 'S', command: 'bash', cwd: workspace },
    { pid: 204, ppid: 7, state: 'Z', command: '<defunct>', cwd: null },
  ], workspace, [ownRun])!, /process 7 remains in the task workspace process tree/);
});

test('only an unreadable process that could reach the task tree reads as unknown', () => {
  const workspace = '/work/task';
  const ownRun = '123e4567-e89b-42d3-a456-426614174000';
  const parent = { pid: 7, ppid: 1, state: 'S', command: 'bash', cwd: workspace };
  assert.match(workspaceToolProcessIssue([
    { pid: 8, ppid: 7, state: 'S', command: 'worker', cwd: null }, parent,
  ], workspace, [ownRun])!, /unreadable working directory/,
    'a live process with an unreadable cwd whose parent is in the task tree is unknown');
  assert.match(workspaceToolProcessIssue([
    { pid: 8, ppid: 7, state: 'R', command: '', cwd: null }, parent,
  ], workspace, [ownRun])!, /unreadable command identity/,
    'a tree process with an unreadable command is unknown');
  assert.equal(workspaceToolProcessIssue([
    { pid: 8, ppid: 1, state: 'S', command: 'worker', cwd: null },
    { pid: 9, ppid: 1, state: 'S', command: 'other', cwd: '/other' },
  ], workspace, [ownRun]), null,
    'a live process whose known parent is unrelated is ignored, whatever its cwd readability');
  assert.equal(workspaceToolProcessIssue([
    { pid: 8, ppid: 1, state: 'R', command: '', cwd: '/other' },
  ], workspace, [ownRun]), null,
    'an unreadable command with a known unrelated parent and cwd is ignored');
});

test('turn settlement never covers partial, status-less or ambiguous evidence', () => {
  assert.match(liveToolIssue([turnCall(undefined, subAgentRunning.timestamp)], idleAgent)!, /without a terminal status/);
  assert.match(liveToolIssue([subAgentRunning, { ...turnCall(undefined, subAgentRunning.timestamp) }], idleAgent)!, /ambiguous states at one instant/);
  assert.match(liveToolIssue([{ ...subAgentRunning, item: { ...subAgentRunning.item, callId: undefined } }], idleAgent)!, /incomplete identity or time/);
  assert.match(liveToolIssue([{ ...subAgentRunning, timestamp: 'not-a-time' }], idleAgent)!, /incomplete identity or time/);
  assert.match(liveToolIssue([subAgentRunning, turnCall('completed', subAgentRunning.timestamp, 'codex-turn-8')], idleAgent)!, /ambiguous states at one instant/);
  assert.equal(liveToolIssue([subAgentRunning, turnCall('running', turnEnded.timestamp, 'codex-turn-8', { name: 'Web search' })], idleAgent), null);
});

// 2026-11-02 (queue#568, project-c#240, project-f#41): a `northstar_queue.northstar_ask` call left running
// after the agent's turn ended held the owned-tool fence, so merge and continuation waited for ever.
// Queue's own MCP tools answer inside the turn, so an idle agent settles them like a sub-agent call.
test("a left-behind Queue MCP tool call is settled on an idle agent and still live while its turn is", () => {
  for (const name of ['northstar_queue.northstar_ask', 'northstar_queue.northstar_report', 'mcp__northstar_queue__northstar_ask', 'nucleus_ask', 'nucleus_report', 'northstar_queue.nucleus_ask', 'mcp__northstar_queue__nucleus_report', 'nucleus.nucleus_ask', 'mcp__nucleus__nucleus_message', 'mcp__nucleus__ask', 'mcp__nucleus__tell', 'nucleus_tell']) {
    const entry = turnCall('running', subAgentRunning.timestamp, 'codex-turn-8', { name, detail: { type: 'unknown' } });
    assert.equal(liveToolIssue([entry], idleAgent), null, name);
    assert.match(liveToolIssue([entry], { ...idleAgent, active: true })!, /is running/, name);
    assert.match(liveToolIssue([entry])!, /is running/, name);
  }
  // Another MCP server's tool keeps the fence.
  const other = turnCall('running', subAgentRunning.timestamp, 'codex-turn-8', { name: 'other_server.tool', detail: { type: 'unknown' } });
  assert.match(liveToolIssue([other], idleAgent)!, /is running/);
  const misleading = turnCall('running', subAgentRunning.timestamp, 'codex-turn-8', { name: 'nucleus_ask', detail: { type: 'shell', command: 'background' } });
  assert.match(liveToolIssue([misleading], idleAgent)!, /is running/);

});
