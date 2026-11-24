import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { HostProcessFact } from "../core/host/types";
import type { CwdState } from "../core/workspaces/worktree-validation";
import {
  dropExitedProcesses,
  inspectedProcessGone,
  readHostUidProcesses,
} from "../core/machine/host-process-listing";
import { readHostProcessTable } from "../core/host/process-table";

test("only a read that proves the process exited drops it from the table", () => {
  assert.equal(
    inspectedProcessGone({ state: "gone" }, { state: "gone" }),
    true,
  );
  assert.equal(
    inspectedProcessGone({ state: "gone" }, { state: "read", path: "/work" }),
    true,
  );
  assert.equal(
    inspectedProcessGone({ state: "read", line: "bash" }, { state: "gone" }),
    true,
  );
  assert.equal(
    inspectedProcessGone({ state: "empty" }, { state: "gone" }),
    true,
    "a zombie that fully exited between the listing and its inspection is gone",
  );
  assert.equal(
    inspectedProcessGone({ state: "unreadable" }, { state: "unreadable" }),
    false,
    "an unreadable inspection stays unknown, never proof of absence",
  );
  assert.equal(
    inspectedProcessGone({ state: "empty" }, { state: "read", path: "/work" }),
    false,
    "a zombie or kernel thread with no argv but a readable cwd stays in the table for the state filter",
  );
  assert.equal(
    inspectedProcessGone(
      { state: "read", line: "bash" },
      { state: "read", path: "/work" },
    ),
    false,
  );
  assert.equal(
    inspectedProcessGone({ state: "empty" }, { state: "unreadable" }),
    false,
  );
});

test("darwin rows whose lsof pass proves them gone leave the table", () => {
  const fact = (pid: number): HostProcessFact => ({
    pid,
    ppid: 1,
    state: "S",
    pgid: 1,
    uid: 501,
    startIdentity: `${pid}@fixture`,
    command: "worker",
    cwd: null,
  });
  // A task child that exited between the ps listing and the lsof read leaves
  // the table, so it cannot block the proof with an unreadable cwd.
  const exitedChild = fact(8);
  const cwds = new Map<number, CwdState>([
    [7, { state: "read", path: "/work/task" }],
    [8, { state: "gone" }],
  ]);
  assert.deepEqual(
    dropExitedProcesses([fact(7), exitedChild], cwds).map((entry) => entry.pid),
    [7],
  );
  assert.equal(
    dropExitedProcesses([fact(7), exitedChild], null).length,
    2,
    "an unusable lsof pass keeps every row unknown instead of proving absence",
  );
});

test(
  "darwin process coverage survives a PID exiting after ps",
  { skip: process.platform !== "darwin" },
  async (t) => {
    assert.ok(process.getuid);
    const uid = process.getuid();
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "host-process-listing-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "held output");
    const start = "Mon Nov 23 18:30:00 2026";
    const otherUid = uid === 0 ? 501 : 0;
    // Freeze the ps snapshot, then run the real lsof against it. The first
    // PID cannot exist on Darwin, so PID selection exits nonzero.
    await writeFile(
      join(root, "ps"),
      `#!/bin/sh
cat <<'ROWS'
${uid} 2147483647 1 1 S ${start} exited-command
${uid} ${process.pid} 1 1 S ${start} live-command
${otherUid} 1 0 1 S ${start} system-command
ROWS
`,
      { mode: 0o755 },
    );
    const handle = await open(file, "w");
    const path = process.env.PATH ?? "";
    process.env.PATH = `${root}${delimiter}${path}`;
    try {
      const read = await readHostUidProcesses();
      assert.equal(read.state, "listed");
      assert.equal(read.cwdComplete, true);
      assert.deepEqual(
        read.processes.map(({ pid, uid }) => ({ pid, uid })),
        [{ pid: process.pid, uid }],
      );
      const files = read.processes[0]?.openFiles;
      assert.equal(files?.complete, true);
      assert.ok(files.paths.includes(file));
    } finally {
      process.env.PATH = path;
      await handle.close();
    }
  },
);

test(
  "darwin cwd coverage ignores zombies before and during the file scan",
  { skip: process.platform !== "darwin" },
  async (t) => {
    assert.ok(process.getuid);
    const uid = process.getuid();
    const root = await mkdtemp(join(tmpdir(), "host-process-zombies-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const start = "Mon Nov 23 18:30:00 2026";
    await writeFile(
      join(root, "ps"),
      `#!/bin/sh
if [ "$4" = 'pid=,stat=' ]; then
  printf '${process.pid} Z+\\n'
  exit 0
fi
cat <<'ROWS'
${uid} 42 1 1 S ${start} live-command
${uid} 43 1 1 Z ${start} <defunct>
${uid} ${process.pid} 1 1 S ${start} exiting-command
ROWS
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "lsof"),
      "#!/bin/sh\nprintf 'p42\\0\\nfcwd\\0n/\\0\\n'\n",
      { mode: 0o755 },
    );
    const path = process.env.PATH ?? "";
    process.env.PATH = `${root}${delimiter}${path}`;
    try {
      const read = await readHostUidProcesses();
      assert.equal(read.state, "listed");
      assert.equal(read.cwdComplete, true);
      assert.deepEqual(
        read.processes.map(({ state, cwd, openFiles }) => [
          state,
          cwd,
          openFiles?.complete,
        ]),
        [
          ["S", "/", true],
          ["Z", null, undefined],
          ["Z+", null, undefined],
        ],
      );
    } finally {
      process.env.PATH = path;
    }
  },
);

test(
  "a darwin process listing killed at its deadline is unknown with its own reason",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "host-process-ps-timeout-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "ps"), "#!/bin/sh\nexec sleep 6\n", {
      mode: 0o755,
    });
    const path = process.env.PATH ?? "";
    process.env.PATH = `${root}${delimiter}${path}`;
    try {
      assert.deepEqual(await readHostUidProcesses(), {
        state: "unknown",
        reason: "the process listing timed out after 5000 ms",
      });
    } finally {
      process.env.PATH = path;
    }
  },
);

test(
  "a darwin open-file listing killed at its deadline is unknown, not missing working-directory coverage",
  { skip: process.platform !== "darwin" },
  async (t) => {
    assert.ok(process.getuid);
    const uid = process.getuid();
    const root = await mkdtemp(join(tmpdir(), "host-process-lsof-timeout-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const start = "Mon Nov 23 18:30:00 2026";
    await writeFile(
      join(root, "ps"),
      `#!/bin/sh
cat <<'ROWS'
${uid} 42 1 1 S ${start} live-command
ROWS
`,
      { mode: 0o755 },
    );
    // The open-file listing outlives its deadline (12 s); a timeout is not an empty table.
    await writeFile(join(root, "lsof"), "#!/bin/sh\nexec sleep 13\n", {
      mode: 0o755,
    });
    const path = process.env.PATH ?? "";
    process.env.PATH = `${root}${delimiter}${path}`;
    try {
      assert.deepEqual(await readHostUidProcesses(), {
        state: "unknown",
        reason: "the open-file listing timed out after 12000 ms",
      });
    } finally {
      process.env.PATH = path;
    }
  },
);

test(
  "a truncated darwin open-file pass stays listed with its working directories, and its open files are incomplete",
  { skip: process.platform !== "darwin" },
  async (t) => {
    assert.ok(process.getuid);
    const uid = process.getuid();
    const root = await mkdtemp(join(tmpdir(), "host-process-truncated-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const start = "Mon Nov 23 18:30:00 2026";
    await writeFile(
      join(root, "ps"),
      `#!/bin/sh
cat <<'ROWS'
${uid} ${process.pid} 1 1 S ${start} live-command
ROWS
`,
      { mode: 0o755 },
    );
    // The real rows, then a warning and a nonzero exit: a truncated listing.
    await writeFile(
      join(root, "lsof"),
      '#!/bin/sh\n/usr/sbin/lsof "$@"\necho "lsof: WARNING: truncated output" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const path = process.env.PATH ?? "";
    process.env.PATH = `${root}${delimiter}${path}`;
    try {
      const read = await readHostUidProcesses();
      assert.equal(read.state, "listed");
      if (read.state !== "listed") return;
      const fact = read.processes.find((entry) => entry.pid === process.pid);
      assert.ok(fact);
      assert.ok(fact.cwd);
      assert.equal(fact.openFiles?.complete, false);
    } finally {
      process.env.PATH = path;
    }
  },
);

test(
  "the host process-table adapter rejects an unknown listing with its named reason",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "host-process-table-timeout-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "ps"), "#!/bin/sh\nexec sleep 6\n", {
      mode: 0o755,
    });
    const path = process.env.PATH ?? "";
    process.env.PATH = `${root}${delimiter}${path}`;
    try {
      await assert.rejects(readHostProcessTable(), {
        message: "the process listing timed out after 5000 ms",
      });
    } finally {
      process.env.PATH = path;
    }
  },
);

test("a truncated listing names the one process it could not read", async () => {
  const { truncatedListingReason } = await import(
    "../core/machine/run-process-custody"
  );
  const uid = process.getuid?.() ?? 0;
  const fact = (
    pid: number,
    extra: Partial<HostProcessFact> = {},
  ): HostProcessFact => ({
    pid,
    ppid: 1,
    state: "S",
    pgid: 1,
    uid,
    startIdentity: `${pid}@fixture`,
    command: "worker",
    cwd: "/work",
    ...extra,
  });
  assert.equal(
    truncatedListingReason({ processes: [fact(1)], cwdComplete: false }),
    "the process listing is truncated",
  );
  assert.equal(
    truncatedListingReason({
      processes: [fact(1), fact(7, { cwd: null })],
      cwdComplete: true,
    }),
    "the working directory of process 7 is unreadable",
  );
  assert.equal(
    truncatedListingReason({
      processes: [
        fact(1),
        fact(8, { openFiles: { paths: [], complete: false } }),
      ],
      cwdComplete: true,
    }),
    "the open files of process 8 are unreadable",
  );
});
