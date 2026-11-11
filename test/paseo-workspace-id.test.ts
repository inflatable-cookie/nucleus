import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkspaceCreateRequestSchema } from '@getpaseo/protocol/messages';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { newPaseoWorkspaceId, paseoWorkspaceIdAccepted } from '../hosts/paseo/adapter/workspace-id';

const request = (workspaceId: string) => ({ type: 'workspace.create.request' as const, workspaceId, requestId: 'ns-review-view-x', title: 'Review',
  source: { kind: 'worktree' as const, cwd: '/tmp/repo', action: 'branch-off' as const, baseBranch: 'a'.repeat(40), branchName: 'ns-review-x', worktreeSlug: 'ns-review-x' } });

test('minted review-view workspace IDs pass the installed protocol; a raw creation UUID does not', () => {
  for (let i = 0; i < 200; i++) {
    const id = newPaseoWorkspaceId();
    assert.equal(paseoWorkspaceIdAccepted(id), true, id);
    assert.equal(WorkspaceCreateRequestSchema.safeParse(request(id)).success, true, id);
  }
  const uuid = randomUUID();
  assert.equal(paseoWorkspaceIdAccepted(uuid), false);
  assert.equal(WorkspaceCreateRequestSchema.safeParse(request(uuid)).success, false);
  assert.equal(paseoWorkspaceIdAccepted(undefined), false, 'absence is never an accepted identity');
});

test('the installed client refuses a raw UUID before its transport send and sends a minted ID', async () => {
  // The real DaemonClient path the creation coordinator uses: schema parse, then sendRequest.
  const client = new DaemonClient({ url: 'ws://127.0.0.1:9', clientId: 'test' } as never) as unknown as {
    sendRequest(params: unknown): Promise<unknown>; sendCorrelatedSessionRequest(params: unknown): Promise<unknown> };
  const sent: Array<{ message: { workspaceId?: string } }> = [];
  client.sendRequest = async params => { sent.push(params as { message: { workspaceId?: string } }); return { ok: true }; };
  const send = (workspaceId: string) => client.sendCorrelatedSessionRequest({ requestId: 'r', message: request(workspaceId), responseType: 'workspace.create.response', timeout: 0 });
  assert.throws(() => send(randomUUID()), (error: Error) => error.name === 'ZodError');
  assert.equal(sent.length, 0, 'nothing reached the transport');
  const id = newPaseoWorkspaceId();
  await send(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.workspaceId, id, 'the caller-selected identity is what Paseo receives');
});
