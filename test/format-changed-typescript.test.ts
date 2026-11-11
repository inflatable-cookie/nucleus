import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changedRegionsFromDiff,
  expandedIntervals,
  formattingPlan,
  gitUnifiedDiff,
  hunkIsContained,
  unifiedHunks,
  type ChangedRegion,
} from "../scripts/format-changed-plan.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formatScript = join(
  workspaceRoot,
  "scripts/format-changed-typescript.mjs",
);
const prettierBin = join(
  workspaceRoot,
  "node_modules/prettier/bin/prettier.cjs",
);

function prettierFormat(content: string): string {
  return execFileSync(
    process.execPath,
    [prettierBin, "--stdin-filepath", "preview.ts"],
    {
      input: content,
      encoding: "utf8",
    },
  );
}

async function gitRun(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
}

/** A throwaway git repository with one committed fixture file. */
async function fixtureRepo(t: TestContext, name: string, content: string) {
  const root = await mkdtemp(join(tmpdir(), "nsq-fmt-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await gitRun(root, ["init"]);
  await gitRun(root, ["config", "user.name", "Queue test"]);
  await gitRun(root, ["config", "user.email", "queue@example.invalid"]);
  await gitRun(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, name), content);
  await gitRun(root, ["add", "-A"]);
  await gitRun(root, ["commit", "-m", "fixture"]);
  return root;
}

function runFmt(root: string) {
  return spawnSync(process.execPath, [formatScript], {
    cwd: root,
    encoding: "utf8",
  });
}

/** The task 544 shape: a large class that was never prettier-formatted, with a JSDoc member mid-file. */
function driftedEngine(): string {
  const lines = [
    'import { readFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "",
    "const CACHE_TTL = 5000;",
    "",
    "export class Engine {",
    "  private cache=new Map<string,string>()",
    "  private hits=0",
    "  constructor(private root: string) {",
    "    this.hits=0",
    "  }",
  ];
  for (let index = 0; index < 12; index += 1) {
    lines.push(
      `  helper${index}(input: string): string { const interim=input.trim(); return interim+"${index}"; }`,
    );
  }
  lines.push("  /**");
  lines.push("   * Refuse displacement while a refusal window is active.");
  lines.push("   */");
  lines.push(
    "  displaceRefusal(target: string): boolean { const refused=this.cache.get(target); return refused!=null }",
  );
  for (let index = 0; index < 12; index += 1) {
    lines.push(
      `  tail${index}(input: string): string { const interim=input.trim(); return interim+"t${index}"; }`,
    );
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

function cleanEngineDraft(): string {
  return [
    'import { readFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "",
    "const CACHE_TTL = 5000;",
    "",
    "export class Engine {",
    "  private cache = new Map<string, string>();",
    "  private hits = 0;",
    "  constructor(private root: string) {",
    "    this.hits = 0;",
    "  }",
    "  /**",
    "   * Refuse displacement while a refusal window is active.",
    "   */",
    "  displaceRefusal(target: string): boolean {",
    "    return this.cache.has(target);",
    "  }",
    "}",
    "",
  ].join("\n");
}

test("unified hunks parse both sides and tolerate omitted counts", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "index 0000000..1111111 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -5 +5,2 @@ function context() {",
    "-old",
    "+new one",
    "+new two",
    "@@ -20,0 +22,3 @@ other context",
    "+inserted",
  ].join("\n");
  assert.deepEqual(unifiedHunks(diff), [
    { oldStart: 5, oldCount: 1, newStart: 5, newCount: 2 },
    { oldStart: 20, oldCount: 0, newStart: 22, newCount: 3 },
  ]);
});

test("changed regions come from the new-file side of a HEAD diff", () => {
  const diff = [
    "diff --git a/one.ts b/one.ts",
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -2,1 +2,3 @@ context",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,9 +0,0 @@ context",
    "diff --git a/two.ts b/two.ts",
    "--- a/two.ts",
    "+++ b/two.ts",
    "@@ -40 +41 @@ context",
  ].join("\n");
  const regions = changedRegionsFromDiff(diff);
  assert.deepEqual(regions.get("one.ts"), [{ line: 2, count: 3 }]);
  assert.deepEqual(regions.get("two.ts"), [{ line: 41, count: 1 }]);
  assert.equal(regions.has("gone.ts"), false);
});

test("expanded intervals clamp at line one and merge neighbours", () => {
  const regions: ChangedRegion[] = [
    { line: 2, count: 1 },
    { line: 6, count: 3 },
    { line: 30, count: 2 },
  ];
  assert.deepEqual(expandedIntervals(regions, 3), [
    { start: 1, end: 11 },
    { start: 27, end: 34 },
  ]);
  assert.deepEqual(expandedIntervals(regions, 0), [
    { start: 2, end: 2 },
    { start: 6, end: 8 },
    { start: 30, end: 31 },
  ]);
});

test("hunk containment accepts changed lines and boundary smoothing only", () => {
  const intervals = expandedIntervals([{ line: 10, count: 2 }], 3);
  assert.equal(
    hunkIsContained(
      { oldStart: 10, oldCount: 2, newStart: 10, newCount: 5 },
      intervals,
    ),
    true,
  );
  assert.equal(
    hunkIsContained(
      { oldStart: 8, oldCount: 5, newStart: 8, newCount: 8 },
      intervals,
    ),
    true,
  );
  assert.equal(
    hunkIsContained(
      { oldStart: 6, oldCount: 9, newStart: 6, newCount: 12 },
      intervals,
    ),
    false,
  );
  assert.equal(
    hunkIsContained(
      { oldStart: 200, oldCount: 40, newStart: 200, newCount: 45 },
      intervals,
    ),
    false,
  );
  // A pure insertion adjacent to the region start stays inside the slack.
  assert.equal(
    hunkIsContained(
      { oldStart: 9, oldCount: 0, newStart: 10, newCount: 3 },
      intervals,
    ),
    true,
  );
  // The same insertion one line further out does not.
  assert.equal(
    hunkIsContained(
      { oldStart: 6, oldCount: 0, newStart: 7, newCount: 3 },
      intervals,
    ),
    false,
  );
  // An insertion reported before old line 1 clamps into the first lines.
  assert.equal(
    hunkIsContained(
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
      expandedIntervals([{ line: 1, count: 1 }], 0),
    ),
    true,
  );
});

test("formatting plan applies changed hunks and reports surrounding drift", () => {
  const current = [
    "line one",
    "line two",
    "line three",
    "line four",
    "drift",
    "drift",
    "line seven",
  ].join("\n");
  const confined = [
    "line one changed",
    "line two",
    "line three",
    "line four",
    "drift",
    "drift",
    "line seven",
  ].join("\n");
  const drifted = [
    "line one changed",
    "line two",
    "line three",
    "line four",
    "Drift",
    "Drift",
    "line seven",
  ].join("\n");
  const regions: ChangedRegion[] = [{ line: 1, count: 1 }];
  const accepted = formattingPlan({
    current,
    formatted: confined,
    regions,
    slack: 3,
    runUnifiedDiff: gitUnifiedDiff,
  });
  assert.equal(accepted.safe, true);
  const rejected = formattingPlan({
    current,
    formatted: drifted,
    regions,
    slack: 3,
    runUnifiedDiff: gitUnifiedDiff,
  });
  assert.equal(rejected.safe, true);
  assert.deepEqual(rejected.drift, [5]);
  assert.equal(rejected.text, confined);
  const broken = formattingPlan({
    current,
    formatted: confined,
    regions,
    slack: 3,
    runUnifiedDiff: () => {
      throw new Error("diff exploded");
    },
  });
  assert.equal(broken.safe, false);
  assert.equal(broken.reason, "diff-failed");
});

test("end to end: a doc comment change formats despite drift elsewhere", async (t) => {
  const committed = driftedEngine();
  const root = await fixtureRepo(t, "engine.ts", committed);
  const edited = (await readFile(join(root, "engine.ts"), "utf8")).replace(
    "Refuse displacement while a refusal window is active.",
    "Refuse displacement while a refusal window or dispute is active.",
  );
  assert.notEqual(edited, committed, "fixture edit must change the file");
  await writeFile(join(root, "engine.ts"), edited);

  // Fixture precondition: the class really is drifted, so whole-file prettier
  // output would reformat far beyond the changed hunk.
  assert.notEqual(prettierFormat(edited), edited);

  const result = runFmt(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(root, "engine.ts"), "utf8"),
    edited,
    "unrelated drift must remain byte-identical",
  );
  assert.match(result.stderr, /fmt: noted engine\.ts/);
  assert.match(result.stderr, /outside the changed hunks/);
  assert.equal(
    gitUnifiedDiff(edited, prettierFormat(edited))
      .split("\n")
      .filter((line) => line.startsWith("@@ ")).length > 1,
    true,
  );
});

test("end to end: formats a changed statement while preserving distant drift", async (t) => {
  const committed = driftedEngine();
  const root = await fixtureRepo(t, "engine.ts", committed);
  const edited = committed.replace(
    "  displaceRefusal(target: string): boolean { const refused=this.cache.get(target); return refused!=null }",
    "  displaceRefusal(target: string): boolean { const refused=this.cache.get(target); return refused!=null; }",
  );
  await writeFile(join(root, "engine.ts"), edited);
  const result = runFmt(root);
  assert.equal(result.status, 0, result.stderr);
  const output = await readFile(join(root, "engine.ts"), "utf8");
  assert.match(
    output,
    /displaceRefusal\(target: string\): boolean \{\n    const refused = this\.cache\.get\(target\);\n    return refused != null;\n  \}/,
  );
  assert.match(
    output,
    /private cache=new Map<string,string>\(\)/,
    "unrelated class drift stays unchanged",
  );
  assert.match(result.stderr, /fmt: noted engine\.ts/);
});

test("end to end: hunks in a clean class format exactly as whole-file prettier would", async (t) => {
  const committed = prettierFormat(cleanEngineDraft());
  const root = await fixtureRepo(t, "engine.ts", committed);
  const edited = committed
    .replace(
      "while a refusal window is active.",
      "while a refusal window or dispute is active.",
    )
    .replace(
      "  private cache = new Map<string, string>();",
      "  private cache = new Map<string, Array<{ path: string; count: number; total: number; latest: string }>>();",
    );
  assert.notEqual(edited, committed, "fixture edits must change the file");
  await writeFile(join(root, "engine.ts"), edited);
  const expected = prettierFormat(edited);
  assert.notEqual(expected, edited, "fixture edits must need formatting");

  const result = runFmt(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(root, "engine.ts"), "utf8"), expected);
  assert.match(result.stdout, /Formatted engine\.ts/);
  assert.doesNotMatch(result.stderr, /skipped/);

  // Nothing outside the edited lines moved relative to the committed base.
  const regions: ChangedRegion[] = [
    {
      line:
        edited
          .split("\n")
          .findIndex((line) => line.includes("refusal window or dispute")) + 1,
      count: 1,
    },
    {
      line:
        edited
          .split("\n")
          .findIndex((line) => line.includes("private cache = new Map")) + 1,
      count: 1,
    },
  ];
  const intervals = expandedIntervals(regions, 3);
  for (const hunk of unifiedHunks(gitUnifiedDiff(committed, expected))) {
    assert.equal(
      hunkIsContained(hunk, intervals),
      true,
      `hunk at old line ${hunk.oldStart} escaped the changed regions`,
    );
  }
});

test("end to end: a formatted tree with no changes reports nothing to format", async (t) => {
  const root = await fixtureRepo(
    t,
    "engine.ts",
    prettierFormat(cleanEngineDraft()),
  );
  const result = runFmt(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "No changed TypeScript files to format.\n");
});

test("end to end: an untracked TypeScript file is formatted wholly", async (t) => {
  const root = await fixtureRepo(t, "keep.ts", "const keep = 1;\n");
  await writeFile(join(root, "extra.ts"), "const x=1\n");
  const result = runFmt(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(root, "extra.ts"), "utf8"),
    "const x = 1;\n",
  );
});
