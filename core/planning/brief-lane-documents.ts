import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LaneDocumentPin, Lane } from '../../shared/contracts';

const keyPattern = '[A-Za-z0-9][A-Za-z0-9._/-]*';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lane document keys named in prose or a Markdown `## Read` section. */
export function briefLaneDocumentReferences(text: string, lanes: readonly Lane[]): { keys: string[]; unresolved: string[] } {
  const known = lanes.map(lane => lane.key);
  const references = new Set<string>();
  for (const key of known) {
    if (new RegExp(`(?:^|[^A-Za-z0-9._/-])${escape(key)}(?:$|[^A-Za-z0-9._/-])`, 'im').test(text)) references.add(key);
  }
  const sections = text.split(/^##\s+/m);
  for (const section of sections) {
    if (!/^Read\b/i.test(section)) continue;
    for (const line of section.slice(section.indexOf('\n') + 1).split('\n')) {
      const item = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?[`*]*([A-Za-z0-9][A-Za-z0-9._/-]*)/);
      if (item) references.add(item[1]);
    }
  }
  for (const match of text.matchAll(new RegExp(`lane\\s+document\\s+(?:named\\s+)?(${keyPattern})|(${keyPattern})\\s+lane\\s+document`, 'gi'))) {
    const candidate = match[1] || match[2];
    if (candidate) references.add(candidate);
  }
  return {
    keys: [...references].filter(key => known.includes(key)),
    unresolved: [...references].filter(key => !known.includes(key)),
  };
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
