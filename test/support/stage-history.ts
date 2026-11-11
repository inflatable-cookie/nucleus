import { readFileSync } from 'node:fs';
import type { StageDefinition } from '../../core/stages';

/** Historical frozen-subject shape, kept local: the execution types are gone. */
export interface StageFrozenSubjectShape {
  head: string | null;
  digests: Array<{ path: string; sha256: string }>;
}
/** Historical verdict-row shape, kept local. */
export interface StageVerdictRowShape {
  id: string;
  verdict: 'pass' | 'fail' | 'insufficient' | 'not_applicable';
  subjectSha256?: string;
  evidenceSha256?: string;
  evidenceBytes?: number;
}

/** Synthetic immutable observations; these records never authenticate a callback. */
export interface StageHistoryFixture {
  format: string;
  capturedAt: string;
  provenance: { taskId: string; taskNumber: number; taskVersion: number; taskRowSha256: string };
  task: { id: string; prHead: string; phase: string; agentId: string; workspaceId: string };
  completion: HistoryCompletion | null;
  mergedCommit: string | null;
  briefVersions: Array<{ version: number; digest: string; plan: { goal: true | string[] | null; stages: Array<{
    id: string; kind: StageDefinition['kind']; subjectId: string; gate: StageDefinition['gate']; outputs?: string[];
  }> } }>;
  stageState: {
    currentIndex: number; records: HistoryRecord[]; history: HistoryRecord[];
    invalidations: Array<{ at: string; reason: string; index: number; stageId: string; records: HistoryRecord[] }>;
  };
  reviews: Array<{ runId: string; agentId: string; head: string; status: string; reviewId: number; verdictSetId: string }>;
  runs: Array<{ id: string; role: string; stageId?: string; head: string | null; base: string | null;
    agentId: string; workspaceId: string; released: boolean; status: string; briefVersion: number;
    completion: HistoryCompletion | null }>;
  events: Array<{ id: number; kind: string; at: string; detailSha256: string; identities: string[]; decision?: string }>;
  tables: {
    subjects: Record<string, StageFrozenSubjectShape | StageDefinition['subject']>;
    verdictSets: Record<string, Array<StageVerdictRowShape>>;
  };
}
export interface HistoryCompletion {
  eventId: string; taskId: string; runId: string; status: string; head?: string; reviewId?: number; verdictSetId?: string;
}
export interface HistoryRecord {
  stageId: string; index: number; kind: StageDefinition['kind']; runId: string | null; agentId: string | null;
  status: string; subjectId: string; verdictSetId: string; reviewId: number | null; at: string;
}
export function stageHistoryFixture(number: 1001 | 1002): StageHistoryFixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/stage-histories/${number}.json`, import.meta.url), 'utf8'));
}
