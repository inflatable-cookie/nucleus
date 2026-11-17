/**
 * The fork's own test runner never builds the board bundle (Spec 062, phase 6):
 * `vitest.config.ts` resolves `./board/nucleus-board.js` here, so the sidebar's
 * app-level tests load the plugin entry with a board registration that does nothing.
 * The board's own tests run in the repository's unit runner against its source.
 */
export function registerNucleusBoard(): null {
  return null;
}
