import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_OUTPUT_DETAIL_LIMIT, BUILD_OUTPUT_NOTE_LIMIT, BUILD_OUTPUT_RECORD_LIMIT,
  boundedBuildOutputDetail, buildOutputDisclosure,
} from '../shared/build-output-disclosure';
import type { BuildOutputCleanup } from '../shared/contracts';

/**
 * What a cleanup observed is the record's own typed field (nucleus#1252). These
 * are the boundary reads a disclosure makes: the observation, the quoted detail,
 * the record bound, the subject's order and the one named run with no record.
 */
const at = (hour: number) => `2026-10-24T0${hour}:00:00.000Z`;
const record = (overrides: Partial<BuildOutputCleanup> = {}): BuildOutputCleanup => ({
  workspaceId: 'workspace', directory: '/worktree', state: 'complete', detail: '', at: at(0), ...overrides,
});

test('a record’s own observations say what it saw, never its detail sentence', () => {
  const removed = buildOutputDisclosure([record({ detail: 'Removed task-local Cargo target output at /worktree/target', observations: ['removed'] })])!;
  assert.match(removed.text, /, a recorded removal\. Recorded detail: "Removed task-local Cargo target output at \/worktree\/target"/);
  const retained = buildOutputDisclosure([record({ observations: ['retained'] })])!;
  assert.match(retained.text, /, output retained for the next continuation\./);
  const link = buildOutputDisclosure([record({ observations: ['link'] })])!;
  assert.match(link.text, /, a symlink left in place whose target was untouched\./);
  const empty = buildOutputDisclosure([record({ observations: ['empty'] })])!;
  assert.match(empty.text, /, no build output root present\./);
  // The sentence is quoted, and the same sentence with no recorded observation
  // claims nothing: a reader never recovers the fact from the prose.
  const unrecorded = buildOutputDisclosure([record({ detail: 'Removed task-local Cargo target output at /worktree/target' })])!;
  assert.doesNotMatch(unrecorded.text, /a recorded removal|output retained/);
  assert.match(unrecorded.text, /Recorded detail: "Removed task-local Cargo target output at \/worktree\/target"/);
  // A cleanup that found the directory absent observed nothing; that is not "empty".
  const absent = buildOutputDisclosure([record({ detail: 'directory absent; nothing to clean up', observations: [] })])!;
  assert.equal(absent.entries[0]!.observations.length, 0);
  assert.doesNotMatch(absent.text, /no build output root present/);
});

test('every observation is named once, in the record’s own order', () => {
  const both = buildOutputDisclosure([record({ observations: ['removed', 'retained'] })])!;
  assert.match(both.text, /a recorded removal and output retained for the next continuation/);
});

test('the disclosure bounds a long detail and the record count, and counts what it leaves out', () => {
  const long = 'Removed task-local Cargo target output at ' + '/worktree/target/'.repeat(200);
  assert.equal(boundedBuildOutputDetail(long).length, BUILD_OUTPUT_DETAIL_LIMIT);
  assert.ok(boundedBuildOutputDetail(long).endsWith('…'));
  assert.equal(boundedBuildOutputDetail('a\u0000 b\n\tc'), 'a b c', 'control characters collapse to one space');
  const disclosure = buildOutputDisclosure(Array.from({ length: BUILD_OUTPUT_RECORD_LIMIT + 2 }, (_, index) =>
    record({ runId: `run-${index}`, detail: long, at: at(index) })))!;
  assert.equal(disclosure.entries.length, BUILD_OUTPUT_RECORD_LIMIT);
  assert.equal(disclosure.omitted, 2);
  assert.match(disclosure.text, /2 further recorded cleanup records exist beyond this bounded disclosure/);
  assert.ok(disclosure.note.length <= BUILD_OUTPUT_NOTE_LIMIT);
  assert.match(disclosure.note, new RegExp(`\\(${BUILD_OUTPUT_RECORD_LIMIT} complete\\)`), 'the count is the quoted records');
});

test('the subject decides the order, marks the run being continued and names the run with no record', () => {
  const disclosure = buildOutputDisclosure([
    record({ runId: 'other-new', workspaceId: 'other', at: at(4) }),
    record({ runId: 'same-old', at: at(1) }),
    record({ runId: 'same-new', at: at(3) }),
    record({ runId: 'other-old', workspaceId: 'other', at: at(2) }),
  ], { workspaceId: 'workspace', runId: 'same-new' })!;
  assert.deepEqual(disclosure.entries.map(entry => entry.runId), ['same-new', 'same-old', 'other-new', 'other-old']);
  assert.deepEqual(disclosure.entries.map(entry => entry.sameWorkspace), [true, true, false, false]);
  assert.deepEqual(disclosure.entries.map(entry => entry.subjectRun), [true, false, false, false]);
  assert.match(disclosure.text, /run same-new \(the run being continued\) in workspace workspace/);
  assert.match(disclosure.text, /run other-new in workspace other, another workspace rather than this checkout/);
  assert.match(disclosure.note, /2 of them in another workspace/);

  const missing = buildOutputDisclosure([record({ runId: 'another-run' })], { workspaceId: 'workspace', runId: 'gone-run' })!;
  assert.equal(missing.missingRunId, 'gone-run');
  assert.match(missing.text, /run gone-run in workspace workspace has no run-bound cleanup record/);
  assert.match(missing.note, /no run-bound cleanup record names run gone-run/);
  // Nothing recorded and nothing named is no disclosure at all.
  assert.equal(buildOutputDisclosure([], {}), null);
  assert.equal(buildOutputDisclosure(null, { runId: null }), null);
});

test('the note keeps the standing limits and the paragraph names "complete" as Nucleus’s own obligation', () => {
  const disclosure = buildOutputDisclosure([record({ observations: ['removed'] })], { workspaceId: 'workspace', runId: 'worker-run' })!;
  assert.match(disclosure.note, /grants no authority to rebuild, reseed, refund budget, replay proof, waive cleanup or retain artifacts/);
  assert.match(disclosure.text, /"complete" records Nucleus's own cleanup obligation for that root; it does not prove the output was deleted/);
  assert.match(disclosure.text, /Prior build artifacts are not guaranteed retained: re-run every command whose output you rely on/);
});
