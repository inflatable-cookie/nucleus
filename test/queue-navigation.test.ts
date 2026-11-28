import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from "./support/board-source";
import { headerControls, settingsViews } from "../shared/queue-navigation";
import { inboxViews } from "../shared/inbox-board";

const ui = boardSource();
const settingsScreen = readFileSync(
  new URL("../client/settings-screen.tsx", import.meta.url),
  "utf8",
);

test("the menu is Needs you, Planning, Leads, Papercuts, Queue, Working, In review and Closing; QA runs is not a board view", () => {
  assert.deepEqual(
    inboxViews.map((view) => view.label),
    [
      "Needs you",
      "Planning",
      "Leads",
      "Papercuts",
      "Queue",
      "Working",
      "In review",
      "Closing",
    ],
  );
  // The bundled board and workspace panel tests also check the rendered menus.
});

test("the list views render the inbox list; Planning keeps its own panes; no Lanes view remains", () => {
  assert.doesNotMatch(ui, /LanesSwitch/);
  assert.match(ui, /view === "planning" \? \(\s*<PlanningTab\b/);
  assert.match(ui, /<InboxList\b/);
  assert.doesNotMatch(ui, /PipelineBoard|tab === "lanes"/);
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
});

test("Settings keeps shared sections and the operator GitHub section behind the same tab row", () => {
  // Projects replaces Repositories (lane nucleus-ui, task 946); Subscriptions folded into Profiles (nucleus#963);
  // Hosts holds the host catalogue and the default host picker (nucleus#1325); Hosts sits after Projects (nucleus#1494).
  // Storage is its own page (nucleus#1526): every work-volume path is edited there,
  // never inside Backups.
  assert.equal(settingsViews.length, 9);
  assert.deepEqual(
    settingsViews.map((view) => view.label),
    [
      "Dispatch limits",
      "Profiles",
      "Projects",
      "Hosts",
      "Backups",
      "Storage",
      "GitHub",
      "Devices",
      "Telemetry",
    ],
  );
  assert.deepEqual(
    settingsViews.map((view) => view.short),
    [
      "Limits",
      "Profiles",
      "Projects",
      "Hosts",
      "Backups",
      "Storage",
      "GitHub",
      "Devices",
      "Telemetry",
    ],
  );
  const legacy = settingsViews.filter(
    ({ id }) => id !== "github-accounts" && id !== "devices",
  );
  const rustOperator = settingsViews.filter(
    ({ id }) => id !== "backups" && id !== "telemetry",
  );
  for (const views of [legacy, rustOperator]) {
    assert.ok(
      views.reduce((sum, { short }) => sum + short.length, 0) <= 52,
      "the visible short labels fit one line",
    );
  }
  assert.match(settingsScreen, /settingsViews\s*\.map\(\(?view\)? =>/);
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
});

test("Telemetry is in Settings and pause remains in the header", () => {
  assert.ok(settingsViews.some((view) => view.id === "telemetry"));
  assert.doesNotMatch(ui, /control\.id === "telemetry"/);
  assert.match(
    settingsScreen,
    /settingsTab === "telemetry" && \(?\s*<SettingsTelemetry/,
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
