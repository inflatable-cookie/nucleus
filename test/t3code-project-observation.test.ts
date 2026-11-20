import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { matchProjectBadges, projectBadgeFor } from "../shared/t3/project-badge";
import { t3Fake } from "./support/t3code-fake";

/**
 * nucleus#1450: the T3 host's project observation is its last synchronized shell read.
 * The board's generated badges read it without any host call of their own, so the
 * observation must keep the project fields the badge rules use (icon metadata, favicon,
 * the workspace root that identifies the repository), and be absent before any read.
 */
test("the host's observation is its last shell read, and carries the icon fields the badges need", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3code-observe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => null,
    reentryTimeoutMs: 300,
  });
  t.after(() => host.close());
  assert.equal(host.projectObservation(), null, "no read yet, so no observation");
  await host.connect();

  const primaryRoot = join(directory, "biock-aase");
  server.projects.push(
    {
      id: "primary",
      title: "Biock Aase",
      workspaceRoot: primaryRoot,
      projectIcon: { kind: "monogram", text: "BX", color: "teal" },
      faviconPath: null,
    },
    {
      id: "favicon-only",
      title: "Icon Project",
      workspaceRoot: join(directory, "icon-project"),
      projectIcon: null,
      faviconPath: "assets/favicon.svg",
    },
  );
  await host.reads.shell();

  const observed = host.projectObservation();
  assert.ok(observed, "the shell read is the observation");
  const primary = observed.find((project) => project.id === "primary");
  assert.ok(primary);
  assert.equal(primary.workspaceRoot, primaryRoot);
  assert.deepEqual(primary.projectIcon, { kind: "monogram", text: "BX", color: "teal" });
  assert.equal(projectBadgeFor(primary)?.monogram, "BX", "T3's own monogram is reused");
  const favicon = observed.find((project) => project.id === "favicon-only");
  assert.ok(favicon);
  assert.equal(projectBadgeFor(favicon), null, "a favicon keeps the normal label");

  const badges = matchProjectBadges({
    tasks: [{ hostId: host.hostId, repoPath: primaryRoot }],
    observations: [{ hostId: host.hostId, projects: observed }],
  });
  assert.deepEqual(badges[host.hostId]?.[primaryRoot], { monogram: "BX", color: "teal" });
});
