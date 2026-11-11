import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { parseNorthstarDocument, submissionQueueFields } from '../core/planning/handoff';
import { stageDeclarationSchema, stageDeclarationFromBrief, stageListSchema } from '../core/stages';
import { stageHistoryFixture } from './support/stage-history';

/** The historical plan digest formula; retained records were built with it. */
const planDigest = (plan: { stages: unknown; goal: unknown }) =>
  createHash('sha256').update(JSON.stringify({ stages: plan.stages, goal: plan.goal ?? null })).digest('hex');

const shared = { head: 'candidate', digests: Array.from({ length: 350 }, (_, index) => ({ path: `inputs/source-${index}.json` })) };
const stages = ['canonical', 'verifier', 'publisher', 'terminal'].map((id, index) => ({
  id, kind: index === 2 ? 'publish' : index === 1 ? 'verify' : 'review', subject: shared,
  role: index === 2 ? 'publisher' : 'reviewer', independence: index ? [index === 1 ? 'canonical' : 'verifier'] : [],
  gate: { pass: [`${id}-gate`], insufficient: [] }, actions: index === 2 ? [{ publish: 'registered-target' }] : ['comment'],
  ...(index === 2 ? { outputs: ['release/receipt.json'] } : {}), wait: [],
}));
const refs = stages.map(stage => ({ ...stage, subject: { ref: 'sources' } }));
const subjectSets = { version: 1, sets: { sources: shared } };
const text = (queue: unknown) => `---\n${stringify({ title: 'Identity fixture', queue_approval: 'Approved fixture', queue }, { aliasDuplicateObjects: false })}---\nFixture body.\n`;

test('350 paths declared once compile to the identical inline plan, gates and semantic digest', () => {
  const inline = stageDeclarationSchema.parse({ stages, goal: true });
  const referenced = stageDeclarationSchema.parse({ stages: refs, subjectSets, goal: true });
  assert.deepEqual(referenced, inline);
  assert.equal(planDigest(referenced), planDigest(inline));
  // Legacy inline identity stays byte-for-byte stable; no upgrade invalidation.
  assert.equal(planDigest(inline), createHash('sha256').update(JSON.stringify({ stages: stageListSchema.parse(stages), goal: true })).digest('hex'));
});

test('admission and runtime use the same compiled stage definitions and omit local declarations from submission', () => {
  const brief = text({ stages: refs, subjectSets, goal: true });
  const admitted = parseNorthstarDocument(brief, 'brief');
  const runtime = stageDeclarationFromBrief(brief)!;
  assert.deepEqual(admitted.queue.stages, runtime.stages);
  assert.deepEqual(runtime, stageDeclarationFromBrief(text({ stages, goal: true })));
  const fields = submissionQueueFields(admitted.queue);
  for (const key of ['stages', 'subjectSets', 'goal']) assert.equal(Object.hasOwn(fields, key), false);
  assert.equal(Object.hasOwn(parseNorthstarDocument(text({}), 'brief').queue, 'stages'), false);
});

test('unknown refs, cycles, unsupported versions, ambiguous replacements and duplicate additions fail admission and runtime', () => {
  const invalid = [
    { stages: refs },
    { stages: refs.map(stage => ({ ...stage, subject: { ref: 'constructor' } })), subjectSets },
    { stages: refs, subjectSets: { version: 1, sets: { sources: shared, 'sources ': shared } } },
    { stages: refs, subjectSets: { ...subjectSets, version: 2 } },
    { stages: refs, subjectSets: { version: 1, sets: { sources: { ref: 'other' }, other: { ref: 'sources' } } } },
    { stages: refs.map(stage => ({ ...stage, subject: { ref: 'sources', head: 'candidate', digests: [] } })), subjectSets },
    { stages: refs.map(stage => ({ ...stage, subject: { ref: 'sources', addDigests: [shared.digests[0]] } })), subjectSets },
    { subjectSets },
  ];
  for (const queue of invalid) {
    assert.throws(() => parseNorthstarDocument(text(queue), 'brief'));
    assert.equal(stageDeclarationFromBrief(text(queue)), null);
  }
});

test('explicit additions retain shared dependencies and cannot silently remove a shared pin', () => {
  const referenced = stageDeclarationSchema.parse({
    stages: refs.map(stage => ({ ...stage, subject: { ref: 'sources', addDigests: [{ path: 'rights/license.json' }] } })), subjectSets,
  });
  for (const stage of referenced.stages) assert.deepEqual(stage.subject.digests, [...shared.digests, { path: 'rights/license.json' }]);
  const unknown = stageDeclarationSchema.safeParse({ stages: refs });
  assert.equal(unknown.success, false);
  if (!unknown.success) assert.deepEqual(unknown.error.issues[0].path, ['stages', 0, 'subject', 'ref']);
});

test('shared sets preserve earlier-only independence, terminal gate and authoring output restrictions', () => {
  for (const changed of [
    refs.map((stage, index) => index === 0 ? { ...stage, independence: ['terminal'] } : stage),
    refs.map((stage, index) => index === 3 ? { ...stage, kind: 'publish' } : stage),
    refs.map((stage, index) => index === 0 ? { ...stage, outputs: ['signed/receipt.json'] } : stage),
  ]) assert.equal(stageDeclarationSchema.safeParse({ stages: changed, subjectSets }).success, false);
});

test('synthetic history preserves report identity, immutable verdict matrices and event associations', () => {
  for (const number of [1001, 1002] as const) {
    const history = stageHistoryFixture(number);
    assert.equal(history.format, 'synthetic-stage-history-v1');
    assert.equal(history.runs.length, 8);
    assert.equal(history.events.length, history.runs.length);
    assert.equal(new Set(history.events.map(event => event.id)).size, history.events.length);
    for (const record of history.stageState.records) {
      assert.ok(history.runs.some(run => run.id === record.runId && run.agentId === record.agentId));
      if (record.reviewId !== null) {
        const review = history.reviews.find(review => review.reviewId === record.reviewId)!;
        assert.equal(review.runId, record.runId);
        assert.equal(review.verdictSetId, record.verdictSetId);
      }
    }
    for (const run of history.runs) {
      assert.equal(run.completion?.runId, run.id);
      assert.equal(run.completion?.taskId, history.task.id);
      assert.ok(history.events.some(event => event.identities.includes(run.completion!.eventId)));
      if (!run.completion?.verdictSetId) continue;
      for (const row of history.tables.verdictSets[run.completion.verdictSetId]) {
        assert.match(row.evidenceSha256!, /^[a-f0-9]{64}$/);
        assert.ok(row.evidenceBytes! > 0);
        assert.equal(Object.hasOwn(row, 'evidence'), false);
      }
    }
  }
});

test('closed synthetic history retains a 36+30 gate, independent stage chain and invalidation', () => {
  const history = stageHistoryFixture(1001);
  const canonical = history.briefVersions.at(-1)!.plan.stages.find(stage => stage.id === 'canonical')!;
  assert.equal(canonical.gate.pass.length, 36);
  assert.equal(canonical.gate.insufficient.length, 30);
  assert.deepEqual(history.stageState.records.map(record => record.stageId), ['prepare', 'canonical', 'verifier', 'publisher', 'terminal']);
  assert.equal(new Set(history.stageState.records.map(record => record.agentId)).size, 5);
  assert.match(history.mergedCommit!, /^[a-f0-9]{40}$/);
  assert.ok(history.events.some(event => event.decision === 'digest_changed at prepare'));
});

test('open synthetic history keeps blocked publication and stale callback distinct from observed head', () => {
  const history = stageHistoryFixture(1002);
  const [blocked, accepted, stale] = history.runs;
  assert.equal(blocked.completion?.status, 'blocked');
  assert.equal(accepted.completion?.status, 'ready_for_review');
  assert.notEqual(blocked.completion?.eventId, accepted.completion?.eventId);
  assert.equal(history.completion?.eventId, stale.completion?.eventId);
  assert.equal(history.completion?.head, stale.completion?.head);
  assert.notEqual(stale.completion?.head, history.task.prHead);
  assert.equal(history.mergedCommit, null);
  assert.equal(history.stageState.currentIndex, 3);
  assert.equal(history.stageState.records.at(-1)?.stageId, 'publisher');
  assert.equal(history.stageState.records.at(-1)?.status, 'blocked');
  assert.ok(!history.stageState.records.some(record => record.stageId === 'terminal'));
  assert.ok(history.stageState.invalidations.some(batch => batch.reason === 'head_changed'));
});

test('synthetic Git shape preserves large-object and terminal-LF boundaries', () => {
  const shape = JSON.parse(readFileSync(new URL('./fixtures/stage-histories/1002-git-shape.json', import.meta.url), 'utf8'));
  const history = stageHistoryFixture(1002);
  assert.equal(shape.taskId, history.task.id);
  assert.equal(shape.candidate, history.task.prHead);
  assert.equal(shape.parents[0], history.completion?.head);
  assert.notEqual(shape.parents[0], shape.parents[1]);
  assert.notEqual(shape.common, shape.candidate);
  assert.equal(shape.deltaEntryCount, 12);
  assert.equal(shape.deltaPathEndpoints, 14, 'rename endpoints remain distinct paths');
  assert.deepEqual(Object.values(shape.objects).map(row => (row as { bytes: number }).bytes), [70000, 72001, 74000, 76002]);
  assert.equal(shape.objects.incoming.terminalLF, false);
  assert.equal(shape.objects.candidate.terminalLF, true);
  assert.equal(shape.owningDocumentProofExpectation.unionBytes + 1, shape.objects.candidate.bytes);
  assert.ok(shape.objects.common.bytes > 65536, 'every synthetic object exceeds the pipe threshold');
});

test('exact owning-document scopes compile for authors and cannot become broad defaults or review declarations', () => {
  const path = 'docs/knowledge/domain/source-documentation.md';
  for (const scope of [['docs/'], ['docs/../source.md'], ['docs/source.md', 'docs/source.md']]) {
    assert.equal(stageDeclarationSchema.safeParse({ stages: stages.map(stage => stage.kind === 'publish' ? { ...stage, preservedOwningDocuments: scope } : stage) }).success, false);
  }
  assert.equal(stageDeclarationSchema.safeParse({ stages: stages.map(stage => ({ ...stage, preservedOwningDocuments: [path] })) }).success, false);
});
