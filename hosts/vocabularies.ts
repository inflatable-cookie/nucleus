import type { HostKind } from '../shared/host-kind';
import type { HostVocabulary } from '../shared/profile-vocabulary';
import { paseoVocabulary } from './paseo/vocabulary';
import { t3codeVocabulary } from './t3code/vocabulary';
import { bbVocabulary } from './bb/vocabulary';

/**
 * Every host adapter's own translation table, by host kind (nucleus#1365). Each
 * table stays owned by its adapter; this is only the list, for the two readers
 * that need every host at once: the stored-profile migration, which maps a
 * host-spelled thinking value back to its canonical level, and the board, which
 * reads a task's routing snapshot back to the canonical level it displays.
 */
export const HOST_VOCABULARIES: Readonly<Record<HostKind, HostVocabulary>> = {
  paseo: paseoVocabulary, t3code: t3codeVocabulary, bb: bbVocabulary,
};
