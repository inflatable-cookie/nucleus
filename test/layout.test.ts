import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import { boardSource } from './support/board-source';
import {fileURLToPath} from 'node:url';
import {checkBridgeImports, checkIsolatedImports} from '../scripts/check-bridge-imports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('Paseo v0.8 uses separate client and server entry points', () => {
  const client = read('hosts/paseo/client/index.tsx');
  const server = read('hosts/paseo/plugin/index.ts');
  assert.match(client, /PluginClientContext/);
  assert.match(client, /from "\.\.\/\.\.\/\.\.\/client\/queue"/);
  assert.ok(client.includes('addSurface') && client.includes('addSidebarItem'));
  assert.match(server, /PluginServerContext/);
  assert.match(server, /from "\.\.\/\.\.\/\.\.\/shared\/rpc-catalogue"/);
  assert.match(server, /ServiceBridge/);
  assert.ok(server.includes('server.handle'));
  assert.equal(read('index.client.tsx'), 'export { default } from "./hosts/paseo/client";\n');
  assert.equal(read('index.server.ts'), 'export { default } from "./hosts/paseo/plugin";\n');
  assert.ok(!existsSync(new URL('../index.ts', import.meta.url)));
});

/**
 * Bridge purity (Contract 007): the backend contribution and its local imports
 * must never reach the Store, engine, Git, hook or routing runtime and must
 * never open a SQLite descriptor. Walk the local import graph from
 * index.server.ts and fail on any forbidden module.
 */
test('the bridge imports no Queue runtime, Store, Git, hook or SQLite module', () => {
  checkBridgeImports(root);
});

test('host-run supervisor and front worker import no Store or runtime modules', () => {
  for (const entry of ['service/executor/host-run-supervisor.ts', 'service/executor/host-run-front-worker.ts']) {
    const graph = checkIsolatedImports(root, entry);
    assert.ok(graph.has('core/host-runs/host-run-files.ts'));
    assert.ok(!graph.has('service/callbacks/host-run-endpoint.ts'), `${entry} must import downward`);
    assert.ok(!graph.has('core/host-runs/host-run-token.ts'), `${entry} does not need token signing`);
  }
});

test('root mcp-report.mjs is a logic-free entry into the canonical bridge', () => {
  const shim = read('mcp-report.mjs');
  assert.match(shim, /'\.\/bin\/mcp-report\.mjs'/);
  for (const logic of ['registerTool', 'StdioServerTransport', 'binding']) {
    assert.ok(!shim.includes(logic), `root mcp-report.mjs must not contain ${logic}`);
  }
  assert.ok(existsSync(new URL('../bin/mcp-report.mjs', import.meta.url)));
  const mcp = read('bin/mcp-report.mjs');
  for (const tool of ['nucleus_report', 'nucleus_ask', 'nucleus_message']) assert.match(mcp, new RegExp(`registerTool\\('${tool}'`));
  for (const retired of ['northstar_report', 'northstar_ask', 'northstar_message']) assert.ok(!mcp.includes(`'${retired}'`), `the retired ${retired} name is not registered`);
});

test('task detail uses a modal and keeps absent resolution-run recovery out of the generic retry button', () => {
  const ui = boardSource();
  assert.match(ui, /<Dialog c=\{c\} title=\{title\} label=\{label\}/);
  assert.match(read("client/controls.tsx"), /<Modal visible transparent animationType="fade"/);
  assert.match(ui, /accessibilityViewIsModal/);
  assert.match(ui, /accessibilityLabel="Close task detail"/);
  // PR #518's TypeScript formatting split JSX props onto their own lines.
  assert.match(ui, /<RecordModal\s+label="Lead detail"/);
  assert.match(ui, /<RecordModal\s+label="Papercut detail"/);
  assert.match(ui, /<Text numberOfLines=\{2\} ellipsizeMode="tail"[^>]*>\{task\.reason\}<\/Text>/);
  assert.doesNotMatch(ui, /LanesSwitch/);
  assert.doesNotMatch(ui, /text="Status"/);
  assert.doesNotMatch(ui, /statusColumn/);
  // #866: the separate Lanes destination is folded into Planning, so its table,
  // row navigation and lane-detail modal are gone. The board's Lanes switch went on 2026-11-08.
  assert.doesNotMatch(ui, /laneTableRows|laneTableTarget|tab === "lanes"/);
  assert.doesNotMatch(ui, /"Lane table header"|accessibilityLabel="Lane detail"/);
  // #866 / #867: the lane's projects and document render in the shared lane screen, which queue.tsx mounts.
  assert.match(read('client/lane-screen.tsx'), /<LaneProjects/);
  assert.match(ui, /<LaneScreen/);
  assert.match(ui, /<PlanningTab/);
  assert.doesNotMatch(ui, /Nothing in this lane/, 'the board has no swim-lane rows to be empty');
  assert.doesNotMatch(ui, /laneBoardColumns/);
  assert.match(ui, /headerControls\(\s*Boolean\(state\?\.paused\)/);
  // Absent resolution runs restart through the Next section (the bespoke alias button was deleted on 2026-10-15).
  assert.doesNotMatch(ui, /action:"retry_absent_resolution"/);
  // A parked step re-runs through restart in Next (round 4: the retry button was deleted on 2026-10-19).
  assert.doesNotMatch(ui, /action:"retry_resolution"|action:"resolve_escalation"/);
  assert.match(ui, /detailQuery\.data\?\.missingResult/);
  assert.match(ui, /Missing result · /);
  assert.doesNotMatch(ui, /Boolean\(detailQuery\.data\?\.runs\.length\)/);
  assert.match(ui, /<CompactTelemetrySummary\s+telemetry=\{detailQuery\.data\.telemetry\}/);
  assert.match(read('client/settings-screen.tsx'), /settingsTab === "telemetry"/);
  // Review #547: the routing form edits the worker's effective thinking level, and the worker request it submits carries none.
  assert.match(ui, /setRoutingThinking\(workerThinking\(task\)\)/);
  assert.match(ui, /worker:\s*\(\(\{\s*thinkingOptionId:\s*_level,\s*\.\.\.request\s*\}\) => request\)/);
});

test('telemetry keeps select filters and renders the three headline categories compactly', () => {
  const ui = read('client/settings-telemetry.tsx');
  const headline = ui.slice(ui.indexOf('function HeadlineMetric'), ui.indexOf('function ReviewerCalibrationSection'));
  assert.match(headline, />\{label\}</);
  assert.match(headline, /category\.rate===null\?"—"/);
  assert.match(headline, /category\.taskCount===1\?"task":"tasks"/);
  assert.match(headline, /category\.factCount===1\?"fact":"facts"/);
  assert.match(ui, /label="Delivery exceptions" category=\{group\.headline\.deliveryExceptions\}/);
  assert.match(ui, /label="Semantic review" category=\{group\.headline\.semanticReview\}/);
  assert.match(ui, /label="Operator administration" category=\{group\.headline\.operatorAdministration\}/);
  assert.match(ui, /accessibilityLabel=\{`Headline categories for \$\{group\.label\}`\}/);
  assert.match(ui, /Raw counters and the legacy intervention rate still include every overlapping fact/);
  for (const filter of ['Group results', 'Scope', 'Worker profile group', 'Closeout', 'Incident role', 'Incident provider']) assert.ok(ui.includes(`label="${filter}"`), `missing ${filter} filter`);
  // Reviewer calibration keeps its own dimension filters, visibly separate from worker and incident routing.
  for (const filter of ['Reviewer provider', 'Reviewer profile', 'Reviewer profile group']) assert.ok(ui.includes(`label="${filter}"`), `missing ${filter} filter`);
  assert.match(ui, /function ReviewerCalibrationSection/);
  assert.match(ui, /Evidence, not quality scores\. Reviewer dimensions stay separate/);
  assert.match(ui, /accessibilityLabel=\{`Reviewer calibration for \$\{group\.label\}`\}/);
  assert.match(ui, /lack the exact-head or reviewer edge and stay out of the denominators/);
  assert.match(ui, /Shadow review \$\{data\?\.shadowPlan\.enabled\?"on":"off"\}/);
  assert.match(ui, /Enabling needs a separate operator decision/);
  assert.match(ui, /reviewerProvider=\{telemetryReviewerProvider\}\s+setReviewerProvider=\{setTelemetryReviewerProvider\}/);
  // Headline colours come from the theme rather than hard-coded values, so dark mode stays intact.
  assert.doesNotMatch(headline, /#[0-9a-fA-F]{3,6}/);
});

test('Profile rows keep the name, status and controls on one line', () => {
  const screen = read('client/settings-screen.tsx');
  const row = screen.slice(screen.indexOf('function ProfileRow'), screen.indexOf('function quietSaveStatus'));
  assert.match(row, /<View style=\{\{ \.\.\.row, flexWrap: "nowrap" \}\}>[\s\S]*?\{profile\.name\}[\s\S]*?icon="TriangleAlert"[\s\S]*?text=\{entry\.enabled[\s\S]*?action=\{editing \? "close" : "edit"\}[\s\S]*?<\/View>/, 'name, status and controls share the first line');
  assert.doesNotMatch(row, /\{model\}/, 'the model is not repeated on the row');
  assert.doesNotMatch(row, /numberOfLines/, 'no live profile row text is ellipsised');
  assert.doesNotMatch(row, /Remove \$\{profile\.name\}/, 'Remove is not on the list row');
  const stale = screen.slice(screen.indexOf('function StalePoolEntry'), screen.indexOf('function Availability'));
  assert.match(stale, /This profile is gone/, 'a stale row says the profile is gone');
  assert.doesNotMatch(stale, /numberOfLines/, 'no stale row text is ellipsised');
});

test('CLI, native UI and Queue MCP forward task controls through the shared contract without a field allowlist', () => {
  const cli = read('bin/queue-cli.mjs');
  assert.match(cli, /`queue\.\$\{method\}`/);
  // The whole payload passes through: the CLI parses it (from stdin or a file) and never picks fields.
  assert.match(cli, /const input = uiCommand .* : readPayload\(file\);/);
  assert.match(read('bin/payload.mjs'), /return JSON\.parse\(text\)/);
  for (const field of ['inspectedPrHead', 'prNumber', 'hookEventId']) assert.ok(!cli.includes(field), `the CLI must pass ${field} through instead of enumerating control fields`);
  const ui = boardSource();
  assert.match(ui, /useRpc\(api\.taskControl\)/);
  // #895 puts low-value technical events behind a disclosure while retaining the original audit row.
  assert.match(ui, /function TechnicalActivityEvents[\s\S]*events\.map\(event => <EventRow key=\{event\.id\} event=\{event\} c=\{c\} \/>\)/);
  assert.match(ui, /accessibilityLabel="Original event kind"[\s\S]*\{event\.kind\}/);
  assert.ok(ui.includes('.filter(event => !lowValueActivityKinds.has(event.kind) && !event.kind.endsWith("_duration")).map((e) => ('),
    'ordinary activity, including reconciled-head events, remains in the main feed');
  assert.match(ui, /TechnicalActivityEvents events=\{\(detailQuery\.data\?\.events \?\? \[\]\)\.filter\(event => lowValueActivityKinds\.has\(event\.kind\) \|\| event\.kind\.endsWith\("_duration"\)\)\}/,
    'technical records, including reconciled-head events, remain reachable from the Activity disclosure');
  assert.match(ui, /function OperationState/);
  assert.match(ui, /operation\.diagnostic/);
  const catalogue = read('shared/rpc-catalogue.ts');
  assert.match(catalogue, /queue\.task.*taskControl/);
  assert.match(catalogue, /queue\.operation-start.*operationStart/);
  assert.match(catalogue, /queue\.operation-status.*operationStatus/);
  assert.match(catalogue, /lane\.upsert.*upsertLane/);
  assert.match(catalogue, /lane\.status.*setLaneStatus/);
  assert.match(catalogue, /lanes.*listLanes/);
});

test('no substantive implementation remains at the repository root', () => {
  const allowed = new Set(['index.client.tsx', 'index.server.ts', 'mcp-report.mjs']);
  const stray = readdirSync(root).filter(name =>
    /\.(ts|tsx|mts|mjs|cjs|js|jsx)$/.test(name) && !allowed.has(name));
  assert.deepEqual(stray, []);
});


test('the bridge transport graph reaches only shared modules; process bindings are injected at registration', () => {
  const entry = 'hosts/paseo/plugin/bridge.ts';
  const graph = checkIsolatedImports(root, entry);
  assert.ok(graph.has('shared/service/client.ts'));
  assert.ok(graph.has('shared/service/bridge-process.ts') === false, 'the structural port erases at runtime');
  for (const path of graph) assert.ok(path === entry || path.startsWith('shared/'), `${entry} reaches process implementation ${path}`);
  assert.match(read('hosts/paseo/plugin/index.ts'), /new ServiceBridge\(\{ processActions: bridgeProcessActions,/);
});


test('the legacy server source root is empty and folder-import debt stays at zero', () => {
  const legacy = new URL('../server/', import.meta.url);
  assert.deepEqual(existsSync(legacy) ? readdirSync(legacy) : [], []);
  assert.deepEqual(JSON.parse(read('test/fixtures/folder-import-violations.json')), []);
});
