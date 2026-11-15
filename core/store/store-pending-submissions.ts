import { submissionSchema, pendingSubmissionSchema, type PendingSubmission, type RepositorySettings } from "../../shared/contracts";
import { type QueueOperation } from "../../shared/operations";
import { StoreCore } from "./store-core";

interface PendingSubmissionAccess {
  canonicalRepository(repoPath: string, origin?: string | null): RepositorySettings | null;
  numberedOperation(data: string): QueueOperation;
  operationPayload(id: string): unknown;
}

/** The submission identity an operation carries, read once from its stored payload. */
type SubmissionPayload = { submission?: unknown; input?: { submission?: unknown } } | null;

/**
 * Spec 026: accepted submissions whose task does not exist yet, so the board shows a
 * "submitting" card before the task appears. The card disappears the moment the task
 * (or its tombstone) exists.
 *
 * An operation whose stored submission cannot be read is not a card: it has no title
 * or repository to show. It stays visible in `operations()`, and removal still refuses
 * through the operation scan, which names the operation's own repository. `unreadable`
 * counts those rows so the scan is never silent about them.
 */
export class StorePendingSubmissions {
  constructor(private readonly core: StoreCore, private readonly access: PendingSubmissionAccess) {}

  pendingSubmissions(): PendingSubmission[] {
    return this.scan().cards;
  }

  /** The board cards and the count of accepted submissions whose payload could not be read. */
  scan(): { cards: PendingSubmission[]; unreadable: number } {
    const known = this.core.db.prepare("SELECT 1 FROM tasks WHERE submission=? UNION ALL SELECT 1 FROM tombstones WHERE submission=? LIMIT 1");
    const cards: PendingSubmission[] = [];
    let unreadable = 0;
    let after = 0;
    while (true) {
      // Paged by rowid so no read cap can hide a pending submission from the board or
      // from a project-removal blocker scan (Spec 027).
      const page = this.core.db.prepare("SELECT rowid AS rid, data FROM operations WHERE state IN ('pending','running') AND kind IN ('submit','review_entry') AND rowid>? ORDER BY rowid LIMIT 500").all(after);
      if (!page.length) break;
      after = Number(page[page.length - 1].rid);
      for (const row of page) {
        const operation = this.access.numberedOperation(String(row.data));
        if (operation.kind !== "submit" && operation.kind !== "review_entry") continue;
        if (operation.taskId || !operation.submissionId || known.get(operation.submissionId, operation.submissionId)) continue;
        const payload = this.access.operationPayload(operation.id) as SubmissionPayload;
        const parsed = submissionSchema.safeParse(payload?.submission ?? payload?.input?.submission);
        if (!parsed.success) { unreadable += 1; continue; }
        const repository = this.access.canonicalRepository(parsed.data.repoPath)?.repository.origin ?? null;
        cards.push(pendingSubmissionSchema.parse({
          id: operation.id, submissionId: operation.submissionId, title: parsed.data.title,
          repoPath: parsed.data.repoPath, repository, lanes: parsed.data.lanes,
          state: operation.state, createdAt: operation.createdAt,
        }));
      }
    }
    return { cards, unreadable };
  }
}
