import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LaneDocumentPin, Lane } from '../../shared/contracts';

/**
 * Spec 026: the lane documents a task declared at admission, split into the
 * keys a lane offers now and the keys it no longer does.
 *
 * The declaration is the task's typed `laneDocuments` list (validated against
 * the lanes and their documents at insert), never an inference from brief
 * prose: a brief naming a lane in passing pins nothing.
 */
export function declaredLaneDocumentKeys(declared: readonly string[] | undefined, lanes: readonly Lane[]): { keys: string[]; unresolved: string[] } {
  const known = new Set(lanes.map(lane => lane.key));
  const keys = [...new Set(declared ?? [])];
  return { keys: keys.filter(key => known.has(key)), unresolved: keys.filter(key => !known.has(key)) };
}

export function laneDocumentScratchPath(directory: string, key: string): string {
  return join(directory, 'lane-documents', `${encodeURIComponent(key)}.md`);
}

/** Write pinned document copies for one run; the files are read-only to its role. */
export function materializeLaneDocuments(directory: string | null | undefined, pins: readonly LaneDocumentPin[] | undefined): string[] {
  if (!directory || !pins?.length) return [];
  const root = join(directory, 'lane-documents');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return pins.map(pin => {
    const path = laneDocumentScratchPath(directory, pin.key);
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    writeFileSync(path, pin.text, { mode: 0o444 });
    chmodSync(path, 0o444);
    return path;
  });
}
