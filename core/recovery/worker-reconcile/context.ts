import type { Resolution } from '../../resolution';
import type { Engine } from '../../engine';

/**
 * The engine and resolution ports the initial worker's reconcile pass reads.
 * The pass is composed in `index.ts`; each step below takes this same context,
 * so a step reads the engine per call exactly as the pass always has (tests
 * replace the adapter).
 */
export type WorkerReconcileContext = Pick<Engine, 'adapter' | 'admission' | 'compareSiblings' | 'hooks' | 'host' | 'idleGraceMs' | 'note' | 'onTaskHost' | 'stopped' | 'store' | 'updateAfterOperatorRemap'>
  & { readonly resolution: Pick<Resolution, 'adoptReplacementPr' | 'attention' | 'extendCallbackReminder' | 'heavyRunAlive' | 'identifyOriginHost' | 'plannerRungsFor' | 'responsibleThreads' | 'withHost' | 'reconcileStalledTurnStop' | 'recovery' | 'remindStoppedWorker' | 'resolveIncident' | 'responsiblePrReportRefused' | 'settleAutomaticReplayHold' | 'stalls' | 'suppressAutomaticRetry' | 'update' | 'waiting'> };
