import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submissionSchema } from "../shared/contracts";
import { Store, digest } from "../core/store/store";
import { REPOSITORY_CONTENTION_GRACE_MS, isRepositoryContention, repositoryContentionNeedsAttention } from "../core/scheduling/repository-contention";

const base = "a".repeat(40);

test("repository contention keeps a burst quiet and elects one leader after grace", () => {
  const dir = mkdtempSync(join(tmpdir(), "northstar-contention-"));
  const store = new Store(join(dir, "queue.sqlite"));
  try {
    const add = (id: string) => store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: "/repo", planningCommit: base, handoffPath: `${id}.md`, originAgentId: "origin" }), "host", "handoff", base);
    const first = add("first"), second = add("second");
    const reason = "Integration checkout is dirty; preserve it and resolve before dispatch";
    assert.equal(isRepositoryContention(reason), true);
    assert.equal(repositoryContentionNeedsAttention(store, first, reason), false);
    store.update(first.id, { reason });
    const episode = store.getMeta<{ taskId: string; since: string }>(`repositoryContention:${digest("/repo")}`);
    assert.equal(episode?.taskId, first.id);
    assert.equal(repositoryContentionNeedsAttention(store, second, reason, Date.parse(episode!.since) + REPOSITORY_CONTENTION_GRACE_MS + 1), false, "siblings never create their own notice");
    assert.equal(repositoryContentionNeedsAttention(store, first, reason, Date.parse(episode!.since) + REPOSITORY_CONTENTION_GRACE_MS + 1), true);

    store.update(first.id, { phase: "done", reason: "Done", finishedAt: new Date().toISOString() });
    assert.equal(repositoryContentionNeedsAttention(store, second, reason, Date.now() + REPOSITORY_CONTENTION_GRACE_MS + 1), false, "a recovered leader starts a fresh episode");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("semantic failures bypass repository contention grace", () => {
  assert.equal(isRepositoryContention("Review found a contract violation"), false);
  assert.equal(isRepositoryContention("Integration checkout is dirty; preserve it and resolve before dispatch"), true);
  assert.equal(isRepositoryContention("Local integration branch must match origin before merge"), true);
  assert.equal(isRepositoryContention("Preserving dirty or switched integration checkout after merge"), true);
  assert.equal(isRepositoryContention("Repository hook ledger task.closeout holds this transition: Integration write requires a clean synchronized base"), false);
});
