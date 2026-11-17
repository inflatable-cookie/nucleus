/**
 * The BB board bundle's entry (Spec 062, phase 6).
 *
 * `scripts/bb/build-board.mjs` bundles this module, with the shared board under
 * `client/`, into `hosts/bb/plugin/board/nucleus-board.js`: react-native resolves
 * to react-native-web, and React, react-dom and the plugin SDK stay external so
 * BB's own runtime supplies them. The plugin's `app.tsx` imports that file and
 * calls `registerNucleusBoard(app, sdk)`.
 */
export { registerNucleusBoard } from "./surfaces";
