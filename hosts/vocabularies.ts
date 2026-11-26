import type { HostKind } from "../shared/host-kind";
import type { HostVocabulary } from "../shared/profile-vocabulary";
import { t3codeVocabulary } from "./t3code/vocabulary";

/**
 * The online host adapter's translation table (nucleus#1365). This is only the
 * list for readers that need the current host vocabulary: profile migration and
 * the board's task routing snapshot display.
 */
export const HOST_VOCABULARIES: Readonly<
  Partial<Record<HostKind, HostVocabulary>>
> = {
  t3code: t3codeVocabulary,
};
