import { fitTitle } from '../../../shared/title-fit';

/**
 * Paseo's title bound. Core hands titles through uncapped; every outbound
 * Paseo title is fitted here, at the adapter boundary.
 */
export const PASEO_TITLE_LIMIT = 200;

/** Fit a title to what Paseo accepts, keeping the shared Unicode-safe cut. */
export function capPaseoTitle(title: string) {
  return fitTitle(title, PASEO_TITLE_LIMIT);
}
