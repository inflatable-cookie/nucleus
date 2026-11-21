import { projectQaRunSchema, type ProjectQaRun } from "../../shared/contracts";
import type { Store } from "../../core/store/store";

/** Emulate the rows a compatibility build committed, including its latest index. */
export function seedLegacyQaRun(store: Store, run: ProjectQaRun): ProjectQaRun {
  const record = projectQaRunSchema.parse(run);
  store.transaction(() => {
    store.db.prepare("INSERT OR REPLACE INTO project_qa_runs (id,repository,data) VALUES (?,?,?)")
      .run(record.id, record.key, JSON.stringify(record));
    store.db.prepare("INSERT OR REPLACE INTO project_qa_latest (key,id) VALUES (?,?)")
      .run(record.key, record.id);
    store.advanceRevision();
  });
  return record;
}
