import { projectQaRunSchema, type ProjectQaRun } from "../../shared/contracts";
import { StoreCore } from "./store-core";

export class StoreProjectQa {
  constructor(private readonly core: StoreCore) {}

  /** Exact request delivery lookup; never fetches, reconciles or submits a host run. */
  qaRequestRecords(input: { requestId: string } | { repository: string; since: string; expectedHead: string }): unknown[] {
    if ("requestId" in input) {
      const record = this.core.getMeta(`projectQaRequest:${input.requestId}`);
      return record ? [record] : [];
    }
    return this.core.db.prepare("SELECT value FROM meta WHERE key GLOB 'projectQaRequest:*' AND json_extract(value,'$.input.repository')=? AND json_extract(value,'$.receivedAt')>=? ORDER BY key LIMIT 101")
      .all(input.repository, input.since).map(row => JSON.parse(String(row.value)));
  }

  qaHistoryForRequest(input: { repository: string; since: string; expectedHead: string }): ProjectQaRun[] {
    return this.core.db.prepare("SELECT data FROM project_qa_runs WHERE (json_extract(data,'$.repository.origin')=? OR json_extract(data,'$.repository.path')=?) AND json_extract(data,'$.base')=? AND COALESCE(json_extract(data,'$.submittedAt'),json_extract(data,'$.startedAt'))>=? ORDER BY rowid LIMIT 101")
      .all(input.repository, input.repository, input.expectedHead, input.since).map(row => projectQaRunSchema.parse(JSON.parse(String(row.data))));
  }

  qaRun(id: string): ProjectQaRun | null {
    const row = this.core.db.prepare("SELECT data FROM project_qa_runs WHERE id=?").get(id);
    return row ? projectQaRunSchema.parse(JSON.parse(String(row.data))) : null;
  }

  /** The board-read current run for one repository key, via the bounded latest index. */
  latestQaRun(key: string): ProjectQaRun | null {
    const link = this.core.db.prepare("SELECT id FROM project_qa_latest WHERE key=?").get(key);
    return link ? this.qaRun(String(link.id)) : null;
  }

  /** Resolve the latest history by its recorded checkout, even when it is offline. */
  latestQaRunForPath(path: string): ProjectQaRun | null {
    const row = this.core.db.prepare(`SELECT r.data FROM project_qa_latest l JOIN project_qa_runs r ON r.id=l.id
      WHERE json_extract(r.data,'$.repository.path')=?
      ORDER BY json_extract(r.data,'$.startedAt') DESC, r.rowid DESC LIMIT 1`).get(path);
    return row ? projectQaRunSchema.parse(JSON.parse(String(row.data))) : null;
  }

  /** Latest run per repository key, newest first, bounded by the latest index plus a row cap. */
  latestQaRuns(limit = 250): ProjectQaRun[] {
    return this.core.db.prepare(`SELECT r.data FROM project_qa_latest l JOIN project_qa_runs r ON r.id=l.id
      ORDER BY json_extract(r.data,'$.startedAt') DESC LIMIT ?`).all(limit)
      .map(row => projectQaRunSchema.parse(JSON.parse(String(row.data))));
  }

}
