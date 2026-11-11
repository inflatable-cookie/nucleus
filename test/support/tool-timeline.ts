import type { TimelineEntry, TimelinePage } from '../../core/recovery/stall';

/** Explicit complete coverage for synthetic histories, including the empty history. */
export function toolTimelinePage(entries: TimelineEntry[], overrides: Partial<TimelinePage> = {}): TimelinePage {
  return { entries, hasOlder: false, hasNewer: false, gap: false, staleCursor: false, reset: false,
    epoch: 'history', projection: 'projected',
    startCursor: entries.length ? { epoch: 'history', seq: 1 } : null,
    endCursor: entries.length ? { epoch: 'history', seq: entries.length } : null, ...overrides };
}

/**
 * Complete empty history for a participant this fixture already observes. The
 * observation map is the fixture's whole authority on which participants exist,
 * in which workspace and in what lifecycle: the shared lease compares those
 * observations itself, so an identity the fixture never observed throws here
 * rather than gaining invented coverage. Missing, foreign, unobserved or live
 * evidence therefore still refuses the merge.
 */
export function observedParticipantTimeline(observations: Map<string, { id: string; workspaceId: string | null }>) {
  return async (id: string): Promise<TimelinePage> => {
    if (!observations.has(id)) throw Error(`the fixture has no observation for participant ${id}`);
    return toolTimelinePage([]);
  };
}

export function toolTimelineTail(entries: TimelineEntry[], limit: number): TimelinePage {
  return toolTimelinePage(entries.slice(-limit), { hasOlder: entries.length > limit,
    startCursor: entries.length ? { epoch: 'history', seq: Math.max(1, entries.length - limit + 1) } : null,
    endCursor: entries.length ? { epoch: 'history', seq: entries.length } : null });
}

export function longToolHistory(count = 450): TimelineEntry[] {
  return Array.from({ length: count }, (_, i) => ({ timestamp: new Date(1_790_000_000_000 + i * 1000).toISOString(),
    item: { type: 'assistant_message', text: `entry ${i}` } }));
}

interface ProjectedEntry extends TimelineEntry { seqStart: number; seqEnd: number }

/** A projected tool span straddles the limit-400 cut in a 450-entry history. */
export function interleavedToolHistory(status: string | undefined): ProjectedEntry[] {
  const entries = longToolHistory().map((entry, i) => ({ ...entry, seqStart: i * 3 + 1, seqEnd: i * 3 + 1 }));
  entries[49].item = { type: 'tool_call', callId: 'earlier', name: 'exec', status };
  entries[50].item = { type: 'tool_call', callId: 'later', name: 'exec', status: 'completed' };
  entries[49].seqEnd = entries[50].seqStart + 1;
  return entries;
}

/**
 * Anchor-extension loop from installed @getpaseo/server 0.11.1
 * agent/timeline-projection.js selectProjectedEntriesTail (Paseo.app app.asar).
 * The response covers the contiguous suffix, including overlapping tool anchors.
 */
export function projectedToolTimelineTail(entries: ProjectedEntry[], limit: number): TimelinePage {
  let start = limit === 0 ? 0 : Math.max(0, entries.length - limit);
  for (let i = start - 1; i >= 0; i--) {
    if (entries[i].seqEnd >= entries[start].seqStart) start = i;
  }
  return toolTimelinePage(entries.slice(start), { hasOlder: start > 0,
    startCursor: entries.length ? { epoch: 'history', seq: entries[start].seqStart } : null,
    endCursor: entries.length ? { epoch: 'history', seq: Math.max(...entries.map(entry => entry.seqEnd)) } : null });
}

/** The first limit-200 tail reaches index 30, already beyond a nominal limit 400. */
export function longAnchorToolHistory(status: string | undefined): ProjectedEntry[] {
  const entries = interleavedToolHistory('completed');
  entries[30].item = { type: 'tool_call', callId: 'long-anchor', name: 'exec', status };
  entries[30].seqEnd = entries[440].seqStart + 1;
  return entries;
}
