import type { Transform } from 'node:stream';

/** The snapshot-pipeline failure a test stands in for, at the position it would fail. */
export type BackupFault = 'read' | 'compress' | 'diskFull' | 'mismatch';

/** The pipeline stages that stand in for the components one failure would break. */
export interface BackupFaultStages {
  /** In place of the snapshot's source read stream. */
  source?: Transform;
  /** After the digest and before the compressor. */
  afterDigest?: Transform;
  /** In place of the gzip compressor. */
  compressor?: Transform;
  /** In place of the compressed write stream. */
  writer?: Transform;
}
/** The slots one fault fills, so it fails where its component would. */
export function backupFaultStages(fault: BackupFault): BackupFaultStages;
/** A pass-through that counts the chunks reaching one pipeline boundary. */
export function countingStage(counts: { chunks: number }): Transform;
