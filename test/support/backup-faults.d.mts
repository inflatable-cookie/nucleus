import type { Transform } from 'node:stream';

/** The snapshot-pipeline failure a test stands in for, at the position it would fail. */
export type BackupFault = 'read' | 'compress' | 'diskFull' | 'mismatch';

/** The stream stage that fails, or corrupts its bytes, the way that failure would. */
export function backupFaultStage(fault: BackupFault): Transform;
