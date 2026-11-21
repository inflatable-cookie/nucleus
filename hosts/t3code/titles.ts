import { fitTitle } from '../../shared/title-fit';

/**
 * T3's row and thread title bound. Core hands titles through uncapped; every
 * outbound T3 title is fitted here, at the adapter boundary.
 */
export const T3_TITLE_LIMIT = 200;

/** Fit a title to what T3 shows, keeping the shared Unicode-safe cut. */
export function capT3Title(title: string) {
  return fitTitle(title, T3_TITLE_LIMIT);
}
