import { Text, View } from "react-native";
import { Icon } from "../shell";
import { muted, row, type Colors } from "../controls";
import type { HeavyRunView, HoldKind, TaskSummary } from "../../shared/contracts";
import { holdBadgeTone, recordBadgeTone, stopBadgeTone, type BadgeTone } from "../../shared/badge-tones";
import { waitStateLabels } from "../../shared/wait-state";
import { taskWaitCardLabel, waitOwnerLabel } from "../../shared/task-detail-summary";
import { plainCardText, type DisplayTask, attention, holdKindLabel, presentHoldKinds, stopBadgeLabel, budgetFields, budgetSummary, interactiveBadgeLabel, elapsedRun } from "./text";
import { useTick } from "../use-tick";

export function HoldBadge({ kind, c }: { kind: HoldKind; c: Colors }) {
  const label = holdKindLabel(kind);
  return <Badge label={label} tone={holdBadgeTone(kind)} c={c} bold a11y={label} />;
}
export function HoldChips({ task, c, decisionTitle }: { task: DisplayTask; c: Colors; decisionTitle?: string | null }) {
  const wait = task.waitState;
  const kinds = presentHoldKinds(task).filter(kind => !(wait?.state === "merge_hold" && kind === "merge"));
  return <>
    {wait ? <WaitBadge wait={wait} c={c} decisionTitle={decisionTitle} /> : null}
    {kinds.map(kind => <HoldBadge key={kind} kind={kind} c={c} />)}
  </>;
}
/**
 * Spec 043 (a): the explicit wait badge. The visible label names the state; the
 * accessibility label carries the owner and next action, so the Pipeline shows
 * who acts and what clears it. A merge hold renders here instead of the Spec 040
 * `Merge held` badge: both state the same fact, and the wait state owns it once.
 */
function WaitBadge({ wait, c, decisionTitle }: { wait: NonNullable<TaskSummary['waitState']>; c: Colors; decisionTitle?: string | null }) {
  const plainWait = taskWaitCardLabel(wait, decisionTitle);
  const label = plainWait ? "Waiting on you" : waitStateLabels[wait.state];
  const tone: BadgeTone = wait.state === 'needs_operator_input' || wait.state === 'needs_source_rights' ? 'warning' : wait.state === 'merge_hold' ? 'accent' : 'neutral';
  return <Badge label={label} tone={tone} c={c} bold a11y={plainWait ?? `Wait state: ${label}; owner ${waitOwnerLabel(wait.owner)}; next ${wait.nextAction}`} />;
}
export function PullRequestBadge({task,state,c,small=false}:{task:DisplayTask;state?:"OPEN"|"CLOSED"|"MERGED";c:Colors;small?:boolean}) {
  if(!task.prUrl)return null;
  const status=task.resolution.mergedCommit?"MERGED":state;
  const blocked=status==="OPEN" && attention(task);
  // Terminal PR state takes precedence over task attention.
  const color=status==="MERGED"?"#a371f7":status==="CLOSED"?"#f85149":blocked?"#f0883e":status==="OPEN"?"#3fb950":c.foregroundMuted;
  const completionNumber = "completionPrNumber" in task ? task.completionPrNumber : "completion" in task ? task.completion?.prNumber ?? undefined : undefined;
  const number=task.resumePrNumber??completionNumber??task.prUrl.match(/\/pull\/(\d+)/)?.[1];
  return <View accessible accessibilityLabel={`Pull request ${number??""}, ${blocked?"open, task needs attention":status?.toLowerCase()??"status unavailable"}`} style={{flexDirection:"row",alignItems:"center",gap:4}}>
    <Icon name={status==="MERGED"?"GitMerge":status==="CLOSED"?"GitPullRequestClosed":"GitPullRequest"} size={small?12:14} color={color}/>
    <Text style={{fontSize:small?11:13,color}}>{number?`PR #${number}`:"PR"}{status==="MERGED"?" · merged":status==="CLOSED"?" · closed":""}</Text>
  </View>;
}
/** The theme colour for a badge tone; neutral keeps the muted badge. */
function toneColor(tone: BadgeTone, c: Colors) {
  return tone === "danger" ? c.statusDanger : tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "accent" ? c.accent : null;
}
/** A card badge: toned badges carry their colour on text and outline over the usual surface. */
export function Badge({ label, tone, c, bold = false, a11y }: { label: string; tone: BadgeTone; c: Colors; bold?: boolean; a11y?: string }) {
  const color = toneColor(tone, c);
  return <View accessible={Boolean(a11y)} accessibilityLabel={a11y ? plainCardText(a11y) : undefined} style={{maxWidth:'100%',paddingHorizontal:7,paddingVertical:2,borderRadius:10,backgroundColor:c.surface2,borderWidth:1,borderColor:color??c.surface2}}>
    <Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:10,...(color?{color}:{}),...(bold?{fontWeight:'600' as const}:{})}}>{plainCardText(label)}</Text></View>;
}
export function RecordChips({chips,c}:{chips:string[];c:Colors}) {
  if(!chips.length)return null;
  return <View style={{...row,gap:6,flexWrap:'wrap'}}>{chips.map(chip=><Badge key={chip} label={chip} tone={recordBadgeTone(chip)} c={c}/>)}</View>;
}
export function StopBadge({ task, c }: { task: Pick<TaskSummary, "stop">; c: Colors }) {
  const label = stopBadgeLabel(task.stop);
  if (!label || !task.stop) return null;
  return <Badge label={label} tone={stopBadgeTone(task.stop)} c={c} a11y={`Stop: ${label}`} />;
}
export function BudgetBadge({ task, c }: { task: Pick<TaskSummary, "budget">; c: Colors }) {
  if (!task.budget) return null;
  const exhausted = budgetFields(task.budget).exhausted;
  const label = `Budget ${budgetSummary(task.budget)}`;
  return <Badge label={label} tone={exhausted ? "warning" : "neutral"} c={c} a11y={exhausted ? `${label}, reached` : label} />;
}
export function InteractiveBadge({ task, c }: { task: Pick<TaskSummary, "interactive" | "stopRecord" | "phase">; c: Colors }) {
  const label = interactiveBadgeLabel(task);
  return label ? <Badge label={label} tone={task.stopRecord?.reason === "interactive" ? "warning" : "accent"} c={c} a11y={label} /> : null;
}
export function LongShellCommandStatus({ startedAt, c }: { startedAt: string; c: Colors }) {
  useTick(30_000);
  return <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Long shell command · {elapsedRun(startedAt)}</Text>;
}
export function HeavyRunStatus({run,c,detail=false}:{run:HeavyRunView;c:Colors;detail?:boolean}) {
  useTick(30_000);
  return <View style={{gap:2}}><Text numberOfLines={1} accessibilityLabel={detail?"Heavy run status":undefined} style={{color:c.statusWarning,fontSize:12,lineHeight:detail?17:16,fontWeight:'600'}}>
    {run.state==='queued'?`Waiting for QA capacity · position ${run.position??'—'}`:`Testing: ${run.selector} · ${elapsedRun(run.launchedAt??run.submittedAt)}`}{run.holder?` · behind ${run.holder}`:''}
  </Text>{!detail&&<Text numberOfLines={1} style={{...muted(c),fontSize:11}}>{run.selector}</Text>}</View>;
}
