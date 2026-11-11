import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submissionSchema, taskSchema } from '../shared/contracts';
import { decideSlotAdmission } from '../core/dispatch/capacity';
import { proofActivationPreview } from '../core/qa/proof-activation';

const sha = 'a'.repeat(40);
const base = taskSchema.parse({
  ...submissionSchema.parse({ submissionId: 's', title: 'T', repoPath: '/r', planningCommit: sha, handoffPath: 'h.md', originAgentId: 'o' }),
  repository: 'owner/asking',
  id: 'asking', hostId: 'h', createdAt: 'now', updatedAt: 'now', version: 1, phase: 'queued', reason: '', held: false,
  handoffText: '', planningBase: sha, workspaceId: null, directory: null, branch: 'ns-t', agentId: null, runId: null,
  profile: null, workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null, completion: null,
  agentActive: null, lastObservedAt: null, prUrl: null, prHead: null, coordinatorGeneration: 1,
});

test('global slot waits qualify task numbers from other repositories', () => {
  const occupant = { ...base, id: 'other', number: 27, repository: 'owner/other', agentActive: true };
  const result = decideSlotAdmission(base, [base, occupant], 1, () => 1,
    { limit: 1, projectKeyFor: task => task.repoPath }, 'Global concurrent task-slot limit reached', [], []);
  assert.match(result, /owner\/other#027/);
});

test('queued proof-only qualification explains automatic slot wait without offering proof', () => {
  const task = { ...base, entrypoint: 'proof', proofOnly: { commit: sha },
    proofExecution: { selector: 'effigy check', inputs: [], role: 'author' }, proofExecutions: [] } as unknown as typeof base;
  const preview = proofActivationPreview(task, [], []);
  assert.deepEqual(preview, { available: false,
    refusal: 'This queued proof-only task runs its qualification by itself when a task slot is available; no proof action is needed' });
});
