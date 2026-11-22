import { join } from "node:path";
import { liveWorkPlacement } from "../workspaces/checkout-volume";

/**
 * Where legacy milestone QA history lives for one data directory. The live store
 * writes and reads the configured `projectQaRoot` (default
 * `<workRoot>/archives/nucleus-project-qa`), and keeps reading the retired
 * `<workRoot>/queue/project-qa` location while an existing install's files are
 * still there. A private data directory (a fixture or a `NUCLEUS_DATA_HOME`
 * instance) keeps its own `project-qa/` folder and never reads the live roots.
 */
export function legacyQaRoots(dataDir: string): {
  live: boolean;
  roots: string[];
  retired: string | null;
} {
  const placement = liveWorkPlacement(dataDir);
  // A data-home copy beside the store is read too: the pre-cutover layout kept one
  // there, and custody must still find whatever it left.
  const local = join(dataDir, "project-qa");
  if (!placement) return { live: false, roots: [local], retired: null };
  const retired = placement.retired.projectQaRoot ?? null;
  return {
    live: true,
    roots: [
      local,
      placement.projectQaRoot,
      ...(retired && retired !== placement.projectQaRoot ? [retired] : []),
    ],
    retired,
  };
}
