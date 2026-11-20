import { test } from "node:test";
import assert from "node:assert/strict";
import {
  T3_PROJECT_BADGE_RENDERER,
  T3_PROJECT_BADGE_TEXT,
  generatedProjectBadge,
  isDarkSurface,
  matchProjectBadges,
  projectBadgeColor,
  projectBadgeFor,
  projectBadgeMapSchema,
  projectBadgeMonogram,
  projectBadgeText,
  type ObservedT3Project,
} from "../shared/t3/project-badge";
import { boardForSurface } from "../service/web/web-board";

/**
 * nucleus#1450: a board card's generated T3 badge matches the installed T3 nightly's
 * `ProjectMonogram` (renderer `T3_PROJECT_BADGE_RENDERER`). The parity table below was
 * produced by running that renderer's own minified `c`/`l`/`u`/`d` functions from the
 * installed app bundle on these titles; the module's rules must reproduce every row.
 */
const PARITY: Array<[title: string, monogram: string, color: string]> = [
  ["biock-aase", "BA", "fuchsia"],
  ["ncock-iase", "NI", "blue"],
  ["bgock-pase", "BP", "pink"],
  ["Biock Aase", "BA", "teal"],
  ["💡 idea", "IA", "sky"],
  ["", "PR", "fuchsia"],
  ["  ", "PR", "fuchsia"],
  ["ß-test", "SS", "teal"],
  ["Project 42 alpha", "PA", "amber"],
  ["x", "XX", "indigo"],
  ["Ａｂｃ１２ ｔｅｓｔ", "A1", "cyan"],
  ["İstanbul-app", "İA", "amber"],
  ["ΣΊΣΥΦΟΣ", "ΣΣ", "red"],
  ["a1b2c3", "A1", "green"],
  ["zz 9 y", "ZY", "green"],
  ["é-cafe", "ÉC", "blue"],
];

test("the renderer rules reproduce the installed nightly's monograms and colours", () => {
  assert.equal(T3_PROJECT_BADGE_RENDERER, "t3code-0.1.12-nightly.20261120.4994");
  for (const [title, monogram, color] of PARITY) {
    assert.deepEqual(
      generatedProjectBadge(title),
      { monogram, color },
      `badge for ${JSON.stringify(title)}`,
    );
  }
});

test("the monogram takes the second character from a later number, else the last run", () => {
  assert.equal(projectBadgeMonogram("alpha9 beta"), "A9");
  assert.equal(projectBadgeMonogram("solo"), "SO");
  assert.equal(projectBadgeMonogram("a"), "AA");
  assert.equal(projectBadgeMonogram("---"), "PR");
});

test("the palette keeps the renderer's order and light and dark text values", () => {
  assert.equal(projectBadgeColor("biock-aase"), "fuchsia");
  assert.equal(
    projectBadgeText({ monogram: "BA", color: "fuchsia" }, false),
    "oklch(59.1% .293 322.896)",
  );
  assert.equal(
    projectBadgeText({ monogram: "BA", color: "fuchsia" }, true),
    "oklch(74% .238 322.16)",
  );
  assert.equal(Object.keys(T3_PROJECT_BADGE_TEXT).length, 18);
});

test("dark and light surfaces pick the matching text value", () => {
  assert.equal(isDarkSurface("#111318"), true);
  assert.equal(isDarkSurface("#f6f7f9"), false);
  assert.equal(isDarkSurface("not-a-colour"), true);
});

const project = (patch: Partial<ObservedT3Project>): ObservedT3Project => ({
  id: "project-1",
  title: "Biock Aase",
  workspaceRoot: "/synthetic/repos/biock-aase",
  archivedAt: null,
  deletedAt: null,
  projectIcon: null,
  faviconPath: null,
  ...patch,
});

test("a T3 project's own monogram icon is reused, and other icons keep the normal label", () => {
  assert.deepEqual(
    projectBadgeFor(project({ projectIcon: { kind: "monogram", text: "BX", color: "teal" } })),
    { monogram: "BX", color: "teal" },
  );
  assert.equal(projectBadgeFor(project({ projectIcon: { kind: "lucide", name: "rocket", color: "red" } })), null);
  assert.equal(projectBadgeFor(project({ projectIcon: { kind: "emoji", emoji: "🚀" } })), null);
  assert.equal(projectBadgeFor(project({ faviconPath: "assets/favicon.svg" })), null);
  assert.equal(
    projectBadgeFor(project({ projectIcon: { kind: "monogram", text: "bad text!", color: "teal" } })),
    null,
    "stored monogram text must match the renderer's text rule",
  );
  assert.equal(
    projectBadgeFor(project({ projectIcon: { kind: "monogram", text: "BX", color: "mauve" } })),
    null,
    "an unknown palette colour is not a badge",
  );
  assert.equal(projectBadgeFor(project({ projectIcon: "legacy-icon" })), null, "an icon of an unknown shape is not a generated badge");
  assert.equal(projectBadgeFor(project({ faviconPath: 42 })), null, "any favicon value keeps the normal label");
  assert.deepEqual(projectBadgeFor(project({ title: "biock-aase" })), { monogram: "BA", color: "fuchsia" });
  assert.deepEqual(
    projectBadgeFor(project({})),
    { monogram: "BA", color: "teal" },
    "the badge follows the T3 title, so Biock Aase is teal",
  );
});

const observation = (projects: ObservedT3Project[], hostId = "t3code:env-a") => ({ hostId, projects });
const task = (repoPath: string, hostId = "t3code:env-a") => ({ hostId, repoPath });

test("a badge matches the repository by its recorded root and uses the T3 title", () => {
  const map = matchProjectBadges({
    tasks: [task("/synthetic/repos/display-name")],
    observations: [
      observation([
        project({ title: "Biock Aase", workspaceRoot: "/synthetic/repos/display-name" }),
      ]),
    ],
  });
  assert.deepEqual(map, {
    "t3code:env-a": { "/synthetic/repos/display-name": { monogram: "BA", color: "teal" } },
  });
});

test("a title-only match is never used, and an absent or ambiguous root keeps the normal label", () => {
  const titled = matchProjectBadges({
    tasks: [task("/repos/other")],
    observations: [observation([project({ title: "biock-aase", workspaceRoot: "/repos/else" })])],
  });
  assert.deepEqual(titled, {});
  const ambiguous = matchProjectBadges({
    tasks: [task("/repos/app")],
    observations: [
      observation([
        project({ id: "a", title: "one", workspaceRoot: "/repos/app" }),
        project({ id: "b", title: "two", workspaceRoot: "/repos/app" }),
      ]),
    ],
  });
  assert.deepEqual(ambiguous, {});
});

test("archived and deleted projects never badge a card, and an unobserved host gives none", () => {
  const map = matchProjectBadges({
    tasks: [task("/repos/app"), task("/repos/gone", "t3code:env-b")],
    observations: [
      observation([
        project({ title: "archived", workspaceRoot: "/repos/app", archivedAt: "2026-11-01T00:00:00.000Z" }),
        project({ title: "deleted", workspaceRoot: "/repos/gone", deletedAt: "2026-11-01T00:00:00.000Z" }),
      ]),
    ],
  });
  assert.deepEqual(map, {});
  assert.deepEqual(matchProjectBadges({ tasks: [task("/repos/app", "paseo:x")], observations: [observation([project({ workspaceRoot: "/repos/app" })])] }), {});
});

test("paths compare canonically, so a symlinked repository still matches its project", () => {
  const canonical = (path: string) => (path.startsWith("/link/") ? path.replace("/link/", "/real/") : path);
  const map = matchProjectBadges({
    tasks: [task("/link/app")],
    observations: [observation([project({ title: "ncock-iase", workspaceRoot: "/real/app" })])],
    canonical,
  });
  assert.deepEqual(map["t3code:env-a"]?.["/link/app"], { monogram: "NI", color: "blue" });
});

test("the wire schema accepts only a palette colour and a bounded monogram", () => {
  assert.ok(projectBadgeMapSchema.safeParse({ "t3code:env-a": { "/repo": { monogram: "BA", color: "fuchsia" } } }).success);
  assert.equal(projectBadgeMapSchema.safeParse({ h: { "/repo": { monogram: "BA", color: "mauve" } } }).success, false);
  assert.equal(projectBadgeMapSchema.safeParse({ h: { "/repo": { monogram: "", color: "blue" } } }).success, false);
});

test("the standalone board never carries project badges; the T3 surface keeps them", () => {
  const board = { revision: 3, projectBadges: { h: { "/repo": { monogram: "BA", color: "fuchsia" } } }, tasks: [] };
  assert.equal("projectBadges" in boardForSurface(board, false), false);
  assert.deepEqual(boardForSurface(board, true), board);
  const ack = { unchanged: true, revision: 3 };
  assert.equal(boardForSurface(ack, false), ack);
  const list = [1, 2];
  assert.equal(boardForSurface(list, false), list);
});
