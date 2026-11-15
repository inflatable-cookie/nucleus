import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { applyLiveUpdate, decodeLiveFrame, readLiveFrames } from '../client/web/live-channel';
import { BOARD_STATE_KEY, nextBoardState } from '../client/board-state';
import { uiBoardSchema, type UiBoard } from '../shared/contracts';

/**
 * The web board's live channel. The service writes `board`, `counters`,
 * `unavailable` frames plus a keepalive; the reader decodes each into the board
 * contract the RPC path parses, and a frame the contract does not carry is
 * refused with its reason instead of being written into the query cache.
 */

const fullBoard = (overrides: Record<string, unknown> = {}) => uiBoardSchema.parse({
  revision: 4, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
  activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5,
  tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
  lanes: [], projects: [], prStates: {}, stoppedThreads: 0, resumedThreads: 0, ...overrides,
});

const ack = (revision: number) => ({
  unchanged: true, revision, connected: true, paused: false, dispatchHeld: false, drained: false, boundRuns: [],
  quiet: true, activeWorkers: 2, unsettled: 1, occupiedSlots: 2, error: '', stoppedThreads: 0, resumedThreads: 0,
});

/** The frame text the service writes (`service/web/web-board.ts` `writeEvent`). */
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test('the reader splits whole frames and keeps a partial one for the next read', () => {
  const first = `retry: 3000\n\n${frame('board', fullBoard())}`;
  const read = readLiveFrames(first);
  assert.equal(read.frames.length, 2);
  assert.deepEqual(read.frames[0], { event: null, data: null }, 'the retry hint carries no event or data');
  assert.equal(read.frames[1].event, 'board');
  assert.equal(read.rest, '');

  const split = readLiveFrames(`: keepalive\n\nevent: counters\ndata: {"unchanged":tr`);
  assert.deepEqual(split.frames.map(item => item.event), [null]);
  assert.equal(split.rest, 'event: counters\ndata: {"unchanged":tr');
  const completed = readLiveFrames(`${split.rest}ue}\n\n`);
  assert.equal(completed.frames.length, 1);
  assert.equal(completed.frames[0].event, 'counters');
  assert.equal(completed.rest, '');
});

test('carriage returns are normalised before a frame is split', () => {
  const read = readLiveFrames(`event: board\r\ndata: ${JSON.stringify(fullBoard())}\r\n\r\n`);
  assert.equal(read.frames.length, 1);
  assert.equal(decodeLiveFrame(read.frames[0]).kind, 'board');
});

test('a board frame is decoded through the same contract the RPC path parses', () => {
  const update = decodeLiveFrame({ event: 'board', data: JSON.stringify(fullBoard()) });
  assert.equal(update.kind, 'board');
  assert.equal(update.kind === 'board' ? update.board.revision : null, 4);
});

test('a frame the board contract does not carry is refused and names why', () => {
  const refused = decodeLiveFrame({ event: 'board', data: JSON.stringify({ ...fullBoard(), tasks: 'not-a-list' }) });
  assert.equal(refused.kind, 'refused');
  assert.match(refused.kind === 'refused' ? refused.reason : '', /Live board frame does not match the board contract/);
  // A counters frame is strict: an unknown counter is a refusal, not a silent merge.
  const unknown = decodeLiveFrame({ event: 'counters', data: JSON.stringify({ ...ack(4), extraCounter: 1 }) });
  assert.equal(unknown.kind, 'refused');
  assert.equal(decodeLiveFrame({ event: 'board', data: 'not json' }).kind, 'refused');
  assert.equal(decodeLiveFrame({ event: 'unavailable', data: 'not json' }).kind, 'refused');
});

test('keepalives, retry hints and events this channel does not carry are ignored', () => {
  assert.equal(decodeLiveFrame({ event: null, data: null }).kind, 'ignored');
  assert.equal(decodeLiveFrame({ event: null, data: '{}' }).kind, 'ignored');
  assert.equal(decodeLiveFrame({ event: 'future-event', data: '{}' }).kind, 'ignored');
  assert.equal(decodeLiveFrame({ event: 'unavailable', data: JSON.stringify({ message: 'host gone' }) }).kind, 'unavailable');
});

test('the live path writes the board cache through the poll\'s own replace-or-merge rule', () => {
  const query = new QueryClient();
  applyLiveUpdate(query, decodeLiveFrame({ event: 'board', data: JSON.stringify(fullBoard()) }));
  assert.equal((query.getQueryData(BOARD_STATE_KEY) as UiBoard).revision, 4);

  // The bounded acknowledgement merges the fresh counters into the retained board.
  applyLiveUpdate(query, decodeLiveFrame({ event: 'counters', data: JSON.stringify(ack(4)) }));
  const merged = query.getQueryData(BOARD_STATE_KEY) as UiBoard;
  assert.equal(merged.revision, 4);
  assert.equal('unchanged' in merged, false, 'the retained projection is kept, not the acknowledgement');
  assert.equal(merged.activeWorkers, 2, 'the counters frame updated the retained board');
  assert.equal('globalLimit' in merged ? merged.globalLimit : null, 32, 'the retained projection is kept');

  // A newer complete board replaces it.
  applyLiveUpdate(query, decodeLiveFrame({ event: 'board', data: JSON.stringify(fullBoard({ revision: 9, activeWorkers: 5 })) }));
  assert.equal((query.getQueryData(BOARD_STATE_KEY) as UiBoard).revision, 9);

  // A refused frame writes nothing.
  const before = query.getQueryData(BOARD_STATE_KEY);
  applyLiveUpdate(query, decodeLiveFrame({ event: 'board', data: '{"revision":"nope"}' }));
  assert.equal(query.getQueryData(BOARD_STATE_KEY), before, 'a refused frame never reaches the cache');
});

test('an unavailable board invalidates the retained projection so the next read asks again', () => {
  const query = new QueryClient();
  applyLiveUpdate(query, decodeLiveFrame({ event: 'board', data: JSON.stringify(fullBoard()) }));
  assert.equal(query.getQueryState(BOARD_STATE_KEY)?.isInvalidated, false);
  applyLiveUpdate(query, decodeLiveFrame({ event: 'unavailable', data: JSON.stringify({ message: 'host gone' }) }));
  assert.equal(query.getQueryState(BOARD_STATE_KEY)?.isInvalidated, true, 'the retained board is invalidated');
});

test('a board read replaces a complete projection and merges only the acknowledgement', () => {
  const retained = fullBoard({ revision: 7, activeWorkers: 1 }) as Exclude<UiBoard, { unchanged: true }>;
  assert.equal(nextBoardState(retained, fullBoard({ revision: 8 })).revision, 8);
  const merged = nextBoardState(retained, ack(7) as UiBoard);
  assert.equal(merged.revision, 7);
  assert.equal(merged.activeWorkers, 2);
  // With nothing retained the acknowledgement is all there is.
  assert.deepEqual(nextBoardState(undefined, ack(7) as UiBoard), ack(7));
});
