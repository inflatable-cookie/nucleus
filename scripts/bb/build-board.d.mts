/** Types for `build-board.mjs` (Spec 062, phase 6): bundle the shared board into the BB plugin. */
export declare const BOARD_BUNDLE: string;
export declare function buildBoard(outfile?: string): Promise<{ outfile: string; bytes: number }>;
