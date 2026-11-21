import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from "./support/board-source";
import {
  headerControls,
  navigationViews,
  settingsViews,
  workspaceNavigationViews,
} from "../shared/queue-navigation";

const ui = boardSource();
const entry = readFileSync(
  new URL("../hosts/paseo/client/index.tsx", import.meta.url),
  "utf8",
);
const settingsScreen = readFileSync(
  new URL("../client/settings-screen.tsx", import.meta.url),
  "utf8",
);

test("navigation exposes Tasks, Planning and QA runs; Usage is removed and Lanes is folded into Planning", () => {
  assert.deepEqual(
    navigationViews.map((view) => view.label),
    ["Tasks", "Planning", "QA runs"],
  );
  assert.deepEqual(
    workspaceNavigationViews.map((view) => view.label),
    ["Tasks", "Planning", "QA runs"],
  );
  // PR #518's TypeScript formatting reformatted the surface; the static reads tolerate the shipped layout.
  assert.match(
    ui,
    /\(workspacePanel\s*\?\s*workspaceNavigationViews\s*:\s*navigationViews\s*\)\.map\(\s*\(view\) =>/,
  );
});

test("Tasks shows the Pipeline with no Lanes switch; no Lanes tab remains", () => {
  assert.doesNotMatch(ui, /LanesSwitch/);
  assert.match(
    ui,
    /tab === "queue" && \(\s*<View style=\{\{ flex: 1, minHeight: 0, gap: space\.sm, zIndex: 0 \}\}>\s*<PipelineBoard\b/,
  );
  assert.doesNotMatch(ui, /tab === "lanes"/);
  assert.doesNotMatch(ui, /accessibilityLabel="Board mode"/);
  assert.doesNotMatch(ui, /text="Status"/);
});

test("header controls expose icon-only Settings, Refresh and Pause or Resume in order", () => {
  const running = headerControls(false, true, false);
  assert.deepEqual(
    running.map((control) => [control.icon, control.label]),
    [
      ["Settings", "Settings"],
      ["RefreshCw", "Refresh"],
      ["Pause", "Pause and drain"],
    ],
  );
  assert.equal(running[2].disabled, false);
  const paused = headerControls(true, true, false);
  assert.deepEqual(
    [paused[2].icon, paused[2].label],
    ["Play", "Resume orchestration"],
  );
  assert.equal(headerControls(false, false, false)[2].disabled, true);
  assert.equal(headerControls(false, true, true)[1].disabled, true);
  assert.equal(headerControls(false, true, true)[1].disabled, true);
  assert.match(ui, /headerControls\(\s*Boolean\(state\?\.paused\)/);
  assert.match(ui, /accessibilityLabel="Queue controls menu"/);
  assert.match(
    ui,
    /Submissions are stored\. No new run starts\. In-flight work drains\./,
  );
  assert.doesNotMatch(ui, /Dispatch and result processing/);
  assert.match(ui, /small iconOnly joined="start"/);
  assert.match(ui, /text=\{control\.label\} disabled=\{control\.disabled\}/);
  assert.match(ui, /name=\{queueMenuOpen \? "ChevronUp" : "ChevronDown"\}/);
  assert.match(
    ui,
    /accessibilityState=\{\{ expanded: queueMenuOpen, disabled: control\.disabled \}\}/,
  );
  const controls = readFileSync(
    new URL("../client/controls.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    controls,
    /accessibilityLabel=\{label\?\?text\} accessibilityHint=\{iconOnly\?text:hint\}/,
  );
  assert.match(controls, /iconOnly&&showHint/);
  assert.match(controls, /joined\?: "start" \| "end"/);
  assert.match(controls, /borderTopRightRadius: 0, borderBottomRightRadius: 0/);
});

test("706: pause chevron menu acts on one press and has no Stop arm", () => {
  for (const paused of [false, true]) {
    assert.equal(
      headerControls(paused, true, false).some(
        (control) => String(control.id) === "stop-threads",
      ),
      false,
    );
  }
  assert.match(
    ui,
    /accessibilityRole="menuitem" accessibilityLabel=\{item\.label\}/,
  );
  assert.match(
    ui,
    /onPress=\{\(\) => \{ setQueueMenuOpen\(false\); item\.run\(\); \}\}/,
  );
  assert.match(ui, /label: state\?\.paused \? "Resume" : "Pause"/);
  assert.match(
    ui,
    /label: state\?\.dispatchHeld \? "Release dispatch hold" : "Dispatch hold"/,
  );
  assert.match(ui, /label: "Stop"/);
  assert.match(
    ui,
    /state\.drained \? "Drained" : `\$\{state\.boundRuns\.length\} bound run/,
  );
  assert.match(
    ui,
    /await setQueue\(\{ paused: true \}\);\s*await stopThreadsRpc/,
  );
  assert.doesNotMatch(ui, /stopThreadsArm/);
  assert.doesNotMatch(ui, /Confirm stop/);
  assert.doesNotMatch(ui, /Pause and stop all active threads\?/);
  assert.doesNotMatch(ui, /Leave drain/);
  assert.doesNotMatch(ui, /key: "drain"/);
});

test("706: an open header menu stacks above the nav row and the outside-press layer", () => {
  // The wrapper's zIndex 50 is trapped inside the title+controls row unless that
  // row itself raises. Old code raised only the wrapper, so All projects (nav
  // row zIndex 20) painted over the menu. Falsify: a relative wrapper zIndex is
  // not enough; the ancestor row must be at 50 while a menu is open.
  assert.match(
    ui,
    /\.\.\.row, justifyContent: "space-between", \.\.\.\(queueMenuOpen \|\| slotsOpen \? \{ zIndex: 50 \} : \{\}\)/,
  );
  assert.match(ui, /position: "relative", zIndex: queueMenuOpen \? 50 : 0/);
  assert.match(ui, /position: "relative", zIndex: slotsOpen \? 50 : 0/);
  assert.match(ui, /justifyContent: "space-between", zIndex: 20/);
  assert.match(ui, /zIndex: 40 \}\}/);
});

test("Settings is the native settings screen holding Dispatch limits, Profiles, Projects, Hosts, Backups and Telemetry", () => {
  // Projects replaces Repositories (lane nucleus-ui, task 946); Subscriptions folded into Profiles (nucleus#963);
  // Hosts holds the host catalogue and the default host picker (nucleus#1325); Hosts sits after Projects (nucleus#1494).
  assert.equal(settingsViews.length, 6);
  assert.deepEqual(
    settingsViews.map((view) => view.label),
    [
      "Dispatch limits",
      "Profiles",
      "Projects",
      "Hosts",
      "Backups",
      "Telemetry",
    ],
  );
  assert.deepEqual(
    settingsViews.map((view) => view.short),
    ["Limits", "Profiles", "Projects", "Hosts", "Backups", "Telemetry"],
  );
  // The tab row stays one line in Paseo's 640–700 point settings column (nucleus#963): short labels only.
  assert.ok(
    settingsViews.reduce((sum, view) => sum + view.short.length, 0) <= 44,
    "the six short labels fit one line",
  );
  assert.match(settingsScreen, /settingsViews\.map\(\(?view\)? =>/);
  for (const view of settingsViews)
    assert.ok(
      settingsScreen.includes(`settingsTab === "${view.id}" &&`),
      `${view.label} panel missing`,
    );
  // The four panels left the main surface; the header's Settings icon opens the native screen.
  assert.doesNotMatch(ui, /settingsTab|settingsViews/);
  assert.match(ui, /control\.id === "settings"\) settingsOpener\?\.\(\)/);
  assert.match(
    ui,
    /export function registerSettingsOpener\(\s*open: \(section\?: SettingsTarget\) => void,?\s*\): void \{\s*settingsOpener = open;\s*\}/,
  );
  assert.match(
    ui,
    /onSettings=\{\s*settingsOpener\s*\? \(\) => settingsOpener\?\.\("projects"\)\s*: undefined,?\s*\}/,
    "the chooser opens Settings at Projects",
  );
  assert.match(
    entry,
    /addSettingsScreen\(\{ id: SETTINGS_SCREEN_ID, title: "Nucleus", icon: "Settings", Component: QueueSettingsScreen \}\)/,
  );
  assert.match(
    entry,
    /registerSettingsOpener\(section => host\.openSettings\(SETTINGS_SCREEN_ID, section \? \{ section \} : undefined\)\)/,
  );
});

test("Telemetry is in Settings and pause remains in the header", () => {
  assert.ok(settingsViews.some((view) => view.id === "telemetry"));
  assert.doesNotMatch(ui, /control\.id === "telemetry"/);
  assert.match(
    settingsScreen,
    /settingsTab === "telemetry" && \(?\s*<SettingsTelemetry/,
  );
});

test("the Tasks tab counts only open tasks in the project selection", async () => {
  const { openTaskCount } = await import("../shared/queue-navigation");
  const task = (
    repoPath: string,
    phase: string,
    extra: Record<string, string> = {},
  ) => ({ repoPath, phase, repository: null, ...extra });
  const tasks = [
    task("/project-l", "working"),
    task("/project-l", "done"),
    task("/project-a", "queued"),
    task("/project-a", "done", { originError: "missing origin" }),
  ];
  assert.equal(
    openTaskCount(tasks, () => true),
    3,
    "all projects: every open task, plus one kept for its origin error",
  );
  assert.equal(
    openTaskCount(tasks, (repoPath) => repoPath === "/project-l"),
    1,
    "filtered to project-l: only its open task",
  );
  const ui = boardSource();
  // #1001: the board carries only queue heads, so the label adds the queued tasks it left out.
  assert.match(
    ui,
    /`Tasks \(\$\{openTaskCount\(state\.tasks, attentionBelongs\) \+ hiddenQueued\} open\)`/,
    "the label uses the selection-aware count",
  );
  assert.match(
    ui,
    /const queuedCounts = \(state\?\.queuedCounts \?\? \[\]\)\.filter\(\(item\) =>\s*attentionBelongs\(item\.repoPath\),?\s*\)/,
    "the left-out count follows the same selection",
  );
});

test("open-task predicate keeps terminal tasks with either origin error", async () => {
  const { isOpenTask } = await import("../shared/queue-navigation");
  assert.equal(isOpenTask({ phase: "cancelled" }), false);
  assert.equal(
    isOpenTask({ phase: "done", originLookupError: "unavailable" }),
    true,
  );
  assert.equal(isOpenTask({ phase: "done", originError: "unavailable" }), true);
  assert.equal(isOpenTask({ phase: "queued" }), true);
});
