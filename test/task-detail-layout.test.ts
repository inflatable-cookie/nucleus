import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardSource } from './support/board-source';

const ui = () => boardSource();

/**
 * Task 538 and task 751: the task detail leads with an overview and keeps its
 * depth in tabs. The derivations themselves are unit-tested separately.
 */
test('the task detail leads with an overview tab and keeps every detail group in tabs', () => {
  const source = ui();
  assert.match(source, /function TaskSummaryBlock/);
  assert.match(source, /<TaskSummaryBlock\n/);
  // The summary: the current wait, who owns it and the next action, then the holds, progress and the newest headline.
  assert.match(source, /const wait = taskOverviewWait\(task\.waitState, next, task\.reason\)/);
  assert.match(source, /accessibilityLabel=\{`Wait: \$\{wait\.state\}; owner \$\{wait\.owner \|\| "none"\}; next \$\{wait\.nextAction \|\| "none"\}`\}/);
  assert.match(source, /accessibilityLabel=\{`Stop: \$\{wait\.stop\.kind\}; \$\{wait\.stop\.reason\}; \$\{wait\.stop\.detail\}`\}/);
  assert.match(source, /const holds = taskHoldRows\(next\)/);
  assert.match(source, /const progress = taskReviewProgress\(next\?\.outcome\)/);
  assert.match(source, /const report = latestTaskReport\(task, runs\)/);
  assert.match(source, /task\.budget && budgetNeedsAttention\(task\.budget\) && <BudgetBars budget=\{task\.budget\}/);
  assert.match(source, /<LatestReportRow report=\{report\}/);
  // The Overview names a stop's suggested verbs that do not apply, with the refusal; the full reference stays in Technical.
  assert.match(source, /const refusals = suggestedVerbRefusals\(next\)/);
  assert.match(source, /Suggested, not available now/);
  assert.match(source, /accessibilityLabel=\{`\$\{verbLabel\(refusal\.verb\)\} not available: \$\{refusal\.reason\}`\}/);
  // Loading and failed reads of the owner verbs say so and offer a retry; a failed refresh says the reading may be stale.
  assert.match(source, /Reading owner verbs…/);
  assert.match(source, /label="Retry reading owner verbs"/);
  assert.match(source, /Refresh failed: \{error\}\. Showing the last reading, which may be stale\./);
  assert.match(source, /loading=\{nextQuery\.isFetching\}/);
  assert.match(source, /onRetry=\{\(\) => \{ void nextQuery\.refetch\(\); \}\}/);
  // The wait is shown once: the Technical tab no longer repeats the wait state or its reason.
  assert.doesNotMatch(source, /Wait reason: \{task\.waitState\.reason\}/);
  assert.doesNotMatch(source, /accessibilityLabel=\{`Wait state: \$\{waitStateLabels\[task\.waitState\.state\]\}; owner/);
  assert.doesNotMatch(source, /STOP_KIND_LABEL/);
  assert.doesNotMatch(source, /taskWhere/);
  assert.match(source, /accessibilityLabel="Task non-delivery telemetry"/);
  assert.match(source, /Non-deliveries · \{telemetry\.nonDelivery\.count\}/);
  assert.match(source, /telemetry\.nonDelivery\.byModel\.map/);
  assert.match(source, /Read full/);
  // Actions: only available verbs, the few that fit first, the rest behind More.
  assert.match(source, /<DetailSection title="What you can do" c=\{c\}>/);
  assert.match(source, /const plan = taskActionPlan\(next\.verbs\)/);
  assert.match(source, /const actions = showMore \? \[\.\.\.plan\.primary, \.\.\.plan\.more, \.\.\.forceVerbs\] : plan\.primary/);
  assert.match(source, /\(plan\.more\.length \+ forceVerbs\.length\) > 0 &&/);
  assert.match(source, /onPress=\{\(\) => setShowMore\(!showMore\)\}/);
  assert.match(source, /<VerbReference verbs=\{nextQuery\.data\.verbs\}/);
  // Pending questions stay mounted in every tab panel, so switching tabs cannot hide an answer.
  assert.match(source, /function PendingQuestions/);
  assert.match(source, /const requests = useTaskQuestionRequests\(ids, hostId \? ids\.map\(id => formatAgentId\(hostId, id\)\) : \[\]\)/);
  assert.match(source, /<NativeQuestionAnswer agentId=\{askerId\} request=\{request\} onAnswered=\{onAnswered\}/);
  assert.match(source, /title="Waiting for your answer"/);
  assert.match(source, /Answer here or in the question pill on the thread; both resolve the same native question\./);
  // Header time comes from the first dispatch, beside the phase chip and PR link.
  assert.match(source, /const taskElapsedMs = taskElapsed\(detailQuery\.data\?\.runs \?\? \[\]\)/);
  assert.match(source, /accessibilityLabel=\{`Elapsed \$\{formatSpan\(taskElapsedMs\)\}`\}/);
  assert.ok(/accessibilityRole="tablist"[\s\S]{0,100}accessibilityLabel="Task detail sections"/.test(source), 'the tab bar has a tablist role');
  assert.match(source, /export function TaskDetailTabs[\s\S]*flexWrap: "wrap"/, 'all five tabs wrap into visible rows on narrow screens');
  assert.match(source, /TaskDetailTabs[\s\S]*minHeight: 44, flexDirection: "row"/, 'each tab keeps an accessible touch target');
  assert.match(source, /Keep the selected task-detail tab local to the open dialog\. Board refreshes[\s\S]{0,100}update its contents without resetting the operator's place\./, 'refreshing task data does not reset the selected section');
  assert.ok(/\[\s*\["overview", "Overview"\],[\s\S]*\["technical", "Technical"\],[\s\S]*\["runs", "Runs & agents"\],[\s\S]*\["messages", "Messages"\],[\s\S]*\["activity", "Activity"\]/.test(source), 'Overview leads the four existing detail tabs');
  assert.match(source, /display: detailTab === "overview" \? "flex" : "none"/);
  assert.match(source, /task && \([\s\S]{0,120}<PendingQuestions/);
  assert.match(source, /display: detailTab === "overview" \? "flex" : "none" \}\}>\s*<NextSection/);
  assert.match(source, /value === "overview" && needsAttention/, 'the Overview tab marks tasks needing attention');
});

test('the old-lifecycle panels are gone from the task detail (Spec 058 step 4)', () => {
  const source = ui();
  assert.doesNotMatch(source, /legacyPanels|detailSections/);
  assert.doesNotMatch(source, /<DemandPreview/);
  assert.doesNotMatch(source, /<TaskOwnerControl/);
  assert.doesNotMatch(source, /<Coordinator\n/);
  assert.doesNotMatch(source, /function IncidentRow/);
  // A refused verb is readable in the technical reference, never as a summary action.
  assert.match(source, /function VerbReference/);
  assert.doesNotMatch(source, /label=\{`\$\{verbLabel\(verb\.verb\)\} unavailable/);
});

test('a board card shows the newest report headline where it used to show only the stored reason', () => {
  // Task 858 rebuilt the card; its snippet reads the report headline.
  const source = ui();
  assert.match(source, /:\s*task\.headline\s*\?\s*<Text\b(?=[^>]*numberOfLines=\{2\})[^>]*>\{task\.headline\}<\/Text>\s*:\s*<Text\b[^>]*>\{task\.reason\}<\/Text>/);
});
