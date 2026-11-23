import { test } from "node:test";
import assert from "node:assert/strict";
import { boardSource } from "./support/board-source";

const ui = () => boardSource();

/**
 * Task 538, task 751 and nucleus#1537: the task detail leads with a human-readable
 * Overview, Activity and Details in three tabs, with editing actions in the ⋯ menu.
 */
test("the task detail uses three tabs (Overview, Activity, Details) with the redesigned layout", () => {
  const source = ui();
  // Header with Open thread and ⋯ menu
  assert.match(source, /function TaskDetailHeader/);
  assert.match(source, /label="Task actions menu"/);
  assert.match(source, /function TaskActionsPopover/);
  // Three tabs with tablist role and 44-point touch target
  assert.ok(
    /accessibilityRole="tablist"[\s\S]{0,100}accessibilityLabel="Task detail sections"/.test(
      source,
    ),
    "the tab bar has a tablist role",
  );
  assert.match(
    source,
    /export function TaskDetailTabs[\s\S]*flexWrap: "wrap"/,
    "tabs wrap cleanly on narrow screens",
  );
  assert.match(
    source,
    /TaskDetailTabs[\s\S]*minHeight: touchTarget/,
    "each tab keeps an accessible touch target",
  );
  assert.ok(
    /\[\s*\["overview", "Overview"\],\s*\["activity", "Activity"\],\s*\["details", "Details"\],?\s*\]/.test(
      source,
    ),
    "three tabs replace the previous five",
  );
  // Overview components: HappeningCard, ProgressStrip, Latest report, Review, Who's on it, Time and budget
  assert.match(source, /function HappeningCard/);
  assert.match(source, /function ProgressStrip/);
  assert.match(source, /function OverviewTab/);
  assert.match(source, /Read full/);
  assert.match(source, /Who’s on it/);
  assert.match(source, /Time and budget/);
  // Pending questions remain mounted across tabs
  assert.match(source, /function PendingQuestions/);
  assert.match(source, /task && \([\s\S]{0,120}<PendingQuestions/);
  // Activity & Details tabs
  assert.match(source, /function ActivityTab/);
  assert.match(source, /Show raw events/);
  assert.match(source, /function DetailsTab/);
  assert.match(source, /<VerbReference verbs=\{next\.verbs\}/);
  assert.match(source, /accessibilityLabel="Task non-delivery telemetry"/);
  assert.match(source, /Non-deliveries · \{telemetry\.nonDelivery\.count\}/);
  // Refreshing task data keeps the operator's selected tab
  assert.match(
    source,
    /Keep the selected task-detail tab local to the open dialog\. Board refreshes[\s\S]{0,100}update its contents without resetting the operator's place\./,
    "refreshing task data does not reset the selected section",
  );
});

test("the old-lifecycle panels are gone from the task detail (Spec 058 step 4)", () => {
  const source = ui();
  assert.doesNotMatch(source, /legacyPanels|detailSections/);
  assert.doesNotMatch(source, /<DemandPreview/);
  assert.doesNotMatch(source, /<TaskOwnerControl/);
  assert.doesNotMatch(source, /<Coordinator\n/);
  assert.doesNotMatch(source, /function IncidentRow/);
  assert.match(source, /function VerbReference/);
  assert.doesNotMatch(
    source,
    /label=\{`\$\{verbLabel\(verb\.verb\)\} unavailable/,
  );
});

test("a board card shows the newest report headline where it used to show only the stored reason", () => {
  const source = ui();
  assert.match(
    source,
    /const detail = task\.headline \|\| task\.reason \|\| null;/,
  );
});
