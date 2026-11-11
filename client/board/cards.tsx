import { useTaskQuestions } from "../native-questions";
import { formatAgentId } from "../../shared/agent-identity";
import { dispatchWaitFence, phaseStateLabel, taskStateLabel } from "../../shared/task-state";
import React, { useState, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../shell";
import { Button, Field, muted, row, type Colors } from "../controls";
import { Popover } from "../popover";
import { taskNumberLabel, type BoardQaRun, type DecisionView, type LaneView, type TaskSummary } from "../../shared/contracts";
import { phaseBadgeTone, recordBadgeTone } from "../../shared/badge-tones";
import { waitStateLabels } from "../../shared/wait-state";
import { isWaitingTaskStop, taskStopClassification } from "../../shared/task-stop";
import { decisionAge } from "../../shared/pipeline-board";
import { decisionProjectLabel, isGeneralDecision } from "../../shared/decision-project";
import { taskWaitCardLabel } from "../../shared/task-detail-summary";
import { projectName, plainCardText, plainCardNode, phaseLabel, phaseIcon, attention, holdKindLabel, presentHoldKinds, stopBadgeLabel, prerequisiteLine, holdReasonPreview, budgetFields, interactiveBadgeLabel, elapsedRun, longShellCommandStart } from "./text";
import { useTick } from "../use-tick";
import { HoldBadge, HoldChips, PullRequestBadge, Badge, RecordChips, StopBadge, BudgetBadge, InteractiveBadge, LongShellCommandStatus, HeavyRunStatus } from "./badges";

/**
 * Spec 026 row 12a: the single card component for the Pipeline view. Task cards
 * render through TaskCard below; papercut and lead cards render through it
 * directly, with their own chips. Only the slot content differs, never the card
 * structure. Lane discovery is Planning's search, not a board surface (#866).
 * Spec 026 row 15a: cards carry no action buttons; clicking one opens the
 * record modal.
 */
export const BoardCard = React.memo(function BoardCard({label,onPress,selected,c,board=true,eyebrow,accessory,title,chips,snippet,footer}:{label:string;onPress:()=>void;selected:boolean;c:Colors;board?:boolean;eyebrow:React.ReactNode;accessory?:React.ReactNode;title:React.ReactNode;chips?:React.ReactNode;snippet?:React.ReactNode;footer?:React.ReactNode}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={plainCardText(label)} onPress={onPress}
    style={{ gap: 7, padding: board ? 12 : 14, paddingTop: board ? 8 : 10, borderRadius: 8, borderWidth: 1, borderColor: selected ? c.accent : c.border, backgroundColor: c.surface1 }}>
    <View style={{...row,flexWrap:'nowrap',justifyContent:'space-between',zIndex:2}}>
      <View pointerEvents="none" style={{flexDirection:'row',alignItems:'center',gap:4,minWidth:0,flex:1}}>{plainCardNode(eyebrow)}</View>
      {plainCardNode(accessory)}</View>
    <View pointerEvents="none" style={{ gap: 7 }}>
      {plainCardNode(title)}
      {plainCardNode(chips)}
      {plainCardNode(snippet)}
      {plainCardNode(footer)}
    </View>
  </Pressable>;
});
/** Milestone QA as a board card (Tom, 2026-11-01): a distinct accent edge, a QA icon and the selector as title. */
const qaStateLabels: Record<BoardQaRun["state"], string> = { queued: "Queued", running: "Running", passed: "Passed", failed: "Failed", hold: "Held", timed_out: "Timed out", cancelled: "Cancelled", lost: "Lost" };
export const QaRunCard = React.memo(function QaRunCard({run,busy,onOpen,onRerun,onCancel,onDismiss,c}:{run:BoardQaRun;busy:boolean;onOpen:()=>void;onRerun:()=>void;onCancel:()=>void;onDismiss:()=>void;c:Colors}) {
  const live=run.state==='queued'||run.state==='running';
  useTick(live ? 30_000 : null);
  const project=run.repository.origin??run.repository.path;
  const lines=run.outputLines.slice(-4);
  return <View accessibilityLabel={`Milestone QA ${run.selector}, ${qaStateLabels[run.state]}, ${project}`} style={{gap:7,padding:12,paddingTop:8,borderRadius:8,borderWidth:1,borderColor:c.border,borderLeftWidth:3,borderLeftColor:c.accent,backgroundColor:c.surface1}}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Open milestone QA run ${run.selector}`} onPress={onOpen} style={{gap:7}}>
      <View style={{...row,flexWrap:'nowrap',justifyContent:'space-between'}}>
        <View style={{flexDirection:'row',alignItems:'center',gap:5,minWidth:0,flex:1}}><Icon name="FlaskConical" size={12} color={c.accent}/><Text numberOfLines={1} style={{...muted(c),fontSize:11,flexShrink:1}}>Milestone QA · {project} · {run.baseBranch}</Text></View>
        <Text style={{color:c.accent,fontSize:11,fontWeight:'700'}}>{qaStateLabels[run.state]}</Text>
      </View>
      <Text numberOfLines={2} style={{color:c.foreground,fontWeight:'600',fontSize:13,lineHeight:17}}>{run.selector}</Text>
      {run.state==='queued'&&<Text numberOfLines={1} style={{color:c.foregroundMuted,fontSize:12}}>Waiting for QA capacity · position {run.queuePosition??'—'}</Text>}
      {run.state==='running'&&<Text numberOfLines={1} style={{color:c.statusWarning,fontSize:12,fontWeight:'600'}}>Step {run.currentStep??'starting'} · {elapsedRun(run.startedAt)}</Text>}
      {run.state==='passed'&&<Text numberOfLines={1} style={{color:c.foregroundMuted,fontSize:12}}>Passed{run.finishedAt?` · ${new Date(run.finishedAt).toLocaleTimeString()}`:''}</Text>}
      {!live&&run.state!=='passed'&&<View style={{gap:2}}>
        <Text numberOfLines={1} style={{color:c.statusWarning,fontSize:12,fontWeight:'600'}}>{run.cancelReason?`Cancelled: ${run.cancelReason}`:`Failed${run.failedStep?` at ${run.failedStep}`:''}${run.exitCode!==null?` · exit ${run.exitCode}`:''}`}</Text>
        {run.stale&&<Text accessibilityLabel={`Stale result: ${run.stale.commitsSince} commits since ${new Date(run.stale.runAt).toLocaleDateString()}`} numberOfLines={1} style={{color:c.statusWarning,fontSize:12,fontWeight:'700'}}>Stale · {run.stale.commitsSince} commits since {new Date(run.stale.runAt).toLocaleDateString()}</Text>}
        {lines.map((line,index)=><Text key={index} numberOfLines={1} style={{...muted(c),fontSize:11,fontFamily:'monospace'}}>{line}</Text>)}
      </View>}
    </Pressable>
    <View style={{...row,gap:6,justifyContent:'flex-end'}}>
      {live&&<Button small c={c} text="Cancel" label={`Cancel milestone QA run ${run.selector}`} disabled={busy} onPress={onCancel}/>}
      {!live&&run.state!=='passed'&&<Button small c={c} text="Re-run" label={`Re-run milestone QA ${run.selector} for ${project}`} disabled={busy} onPress={onRerun}/>}
      {!live&&run.state!=='passed'&&<Button small c={c} text="Dismiss" label={`Dismiss milestone QA run ${run.selector}`} disabled={busy} onPress={onDismiss}/>}
      <Button small c={c} text="Details" label={`Open details for milestone QA run ${run.selector}`} onPress={onOpen}/>
    </View>
  </View>;
});
/**
 * Tom, 2026-11-07 (UI lane, step 2): a board task card says what is happening, what is
 * waiting and who or what moves it next. Long IDs, lanes, profiles and timestamps live in
 * the task view; the card keeps the holds, waits and attention a scan needs.
 */
export const TaskCard = React.memo(function TaskCard({task,selected,onPress,prState,c,board=false,parked=false,decisions=false,decisionTitle,defaultHostId}:{task:TaskSummary;selected:boolean;onPress:()=>void;prState?:"OPEN"|"CLOSED"|"MERGED";c:Colors;board?:boolean;parked?:boolean;decisions?:boolean;decisionTitle?:string|null;defaultHostId?:string}) {
  const [statusTip,setStatusTip]=useState(false);
  const statusAnchor=useRef<View|null>(null);
  const hostId = task.hostId ?? defaultHostId;
  const questions = useTaskQuestions(task.questionAgentIds ?? [], hostId ? task.questionAgentIds?.map(id => formatAgentId(hostId, id)) : []);
  const archiveRetry=task.resolution.archiveRetry;
  const holdKinds = presentHoldKinds(task).filter(kind => !(task.waitState?.state === "merge_hold" && kind === "merge"));
  const plainWait = taskWaitCardLabel(task.waitState, decisionTitle);
  const holdLabel = [task.waitState ? waitStateLabels[task.waitState.state] : null, ...holdKinds.map(holdKindLabel)].filter(Boolean).map(label => `, ${label}`).join("");
  const stopLabel = stopBadgeLabel(task.stop);
  const stopRecord = task.stopRecord;
  const interactiveLabel = interactiveBadgeLabel(task);
  // The live dispatch hold is the wait; the stored reason may still name a cleared cause.
  const dispatchWait = dispatchWaitFence(task);
  const classifiedStop = stopRecord ? taskStopClassification(stopRecord.detail) : null;
  const stopWait = stopRecord ? isWaitingTaskStop(classifiedStop!.reason) || isWaitingTaskStop(stopRecord.reason) : false;
  const stopHeld = Boolean(stopRecord && (classifiedStop?.reason === "held" || stopRecord.reason === "held"));
  const attentionOwner = stopRecord?.reason === "operator_needed" || stopRecord?.reason === "run_stalled"
    ? "you" : task.stopDisplayOwner ?? "the task owner";
  const attentionNext = stopRecord?.reason === "operator_needed" ? "Your decision is next"
    : stopRecord?.reason === "run_stalled" ? "Your action is next" : `${attentionOwner} moves it next`;
  const stopDetail = stopRecord?.detail.replace(/^(Dispatch|Merge) held by [^:]+:/i, (_match, kind: string) => `${kind} held by ${task.holdDisplayOwner ?? "a planner thread"}:`)
    .replace(/Waiting with the planner or task owner\s+[0-9a-f-]{36}:\s*blocker escalation\s+[0-9a-f]{40,64}/i,
      `Waiting on ${task.stopDisplayOwner ?? "the task owner"} · blocker escalation`);
  const cardAttention = attention(task) && !stopWait;
  const prerequisite = prerequisiteLine(task);
  const longCommandStartedAt = longShellCommandStart(task.reason);
  const budgetExhausted = Boolean(task.budget && budgetFields(task.budget).exhausted);
  const attentionPriority = Boolean(cardAttention || archiveRetry || (stopRecord && !stopWait));
  const next = plainWait ? <Text numberOfLines={2} ellipsizeMode="tail" style={{color:c.foregroundMuted,fontSize:12,lineHeight:16}}>{plainWait}</Text>
    : task.heavyRun ? <HeavyRunStatus run={task.heavyRun} c={c}/>
    : questions.length ? <View style={{gap: 3}}>{questions.flatMap(request => request.questions.map(q => <Text key={`${request.id}:${q.header}`} numberOfLines={2} style={{color:c.statusWarning,fontSize:12,lineHeight:16}}>Question · {q.question}</Text>))}</View>
    : archiveRetry ? <Text numberOfLines={2} ellipsizeMode="tail" style={{color:c.statusWarning,fontSize:12,lineHeight:16}}>Workspace archive failed: {archiveRetry.error}</Text>
    : prerequisite ? <Text numberOfLines={2} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{prerequisite}</Text>
    : longCommandStartedAt ? <LongShellCommandStatus startedAt={longCommandStartedAt} c={c}/>
    : dispatchWait ? <View style={{gap:2}}>
      <Text accessibilityLabel={`Hold reason preview: ${holdReasonPreview(dispatchWait.reason)}`} numberOfLines={2} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>Hold reason preview · {holdReasonPreview(dispatchWait.reason)}</Text>
      <Text numberOfLines={1} style={{...muted(c),fontSize:11}}>Dispatch held by {task.holdDisplayOwner ?? "a planner thread"}{dispatchWait.since ? ` · ${decisionAge(dispatchWait.since)}` : " · age not recorded"}</Text>
      {(task.originError||task.originLookupError) && <Text numberOfLines={1} ellipsizeMode="tail" style={{color:c.statusWarning,fontSize:11}}>Origin routing: {task.originError||task.originLookupError}</Text>}
    </View>
    : stopRecord ? <View style={{gap:2}}>
      <Text numberOfLines={2} ellipsizeMode="tail" style={{ color: stopWait || stopHeld ? c.foregroundMuted : c.statusWarning, fontSize: 12, lineHeight: 16 }}>{stopWait ? stopDetail!.replace(/^(?:lifecycle|prerequisite|capacity|validation):?\s*/i, "") : stopHeld ? stopDetail : stopDetail}</Text>
      <Text numberOfLines={1} style={{...muted(c),fontSize:11}}>{stopWait ? `Waiting · ${decisionAge(stopRecord.since)}` : stopHeld ? `Held · ${decisionAge(stopRecord.since)}` : `Needs attention · ${attentionNext} · ${decisionAge(stopRecord.since)}`}</Text>
    </View>
    : task.headline ? <Text numberOfLines={2} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{task.headline}</Text>
    : <Text numberOfLines={2} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{task.reason}</Text>;
  // The stop badge is suppressed where the phase line already says it, so it does not count toward the chips row.
  const showStopBadge = Boolean(stopLabel) && !stopWait && !stopHeld && !(task.stop==='attention'&&['needs_attention','blocked','error'].includes(task.phase));
  const hasChips = Boolean(parked||decisions||task.parked||task.pausedStop||interactiveLabel||task.waitState||holdKinds.length||showStopBadge||budgetExhausted);
  const hasFooter = task.queuePriority>0 || task.dependsOn.length>0 || Boolean(task.prUrl);
  const stopA11y = stopRecord ? stopWait ? `Waiting: ${stopDetail}` : stopHeld ? `Held: ${stopDetail}` : `Needs attention: ${stopDetail}; next owner ${attentionOwner}` : "";
  const holdOwnerA11y = !dispatchWait && task.holds?.merge ? `, Merge held by ${task.holdDisplayOwner ?? "a planner thread"}` : dispatchWait ? `, Dispatch held by ${task.holdDisplayOwner ?? "a planner thread"}` : "";
  const accessibleWait = plainWait
    ? `, ${plainWait}`
    : task.heavyRun
      ? `, ${task.heavyRun.state === "queued" ? `Waiting for QA capacity · position ${task.heavyRun.position ?? "unknown"}` : `QA run ${task.heavyRun.state}`}`
    : questions.length
      ? `, Question: ${questions.flatMap(request => request.questions.map(question => question.question)).join("; ")}`
    : archiveRetry
      ? `, Workspace archive failed: ${archiveRetry.error}`
    : prerequisite
      ? `, ${waitStateLabels.waiting_prerequisite}: ${prerequisite}`
    : longCommandStartedAt
      ? `, Long shell command · ${elapsedRun(longCommandStartedAt)}`
    : dispatchWait
      ? `, Hold reason preview: ${holdReasonPreview(dispatchWait.reason)}`
    : stopA11y ? `, ${stopA11y}`
    : task.headline ? `, ${task.headline}`
    : task.reason ? `, ${task.reason}` : "";
  const accessibleHold = plainWait || prerequisite ? holdKinds.map(holdKindLabel).map(label => `, ${label}`).join("") : holdLabel;
  const fullHoldReasonA11y = dispatchWait ? `, Full hold reason: ${dispatchWait.reason}` : "";
  return <BoardCard label={`${projectName(task)}, ${task.title}, ${phaseLabel(task)}${interactiveLabel ? `, ${interactiveLabel}` : ""}${accessibleHold}${holdOwnerA11y}${accessibleWait}${fullHoldReasonA11y}${stopLabel && !stopWait && !stopHeld ? `, ${stopLabel}` : ""}${!accessibleWait && stopA11y ? `, ${stopA11y}` : ""}, Action: open task details`} onPress={onPress} selected={selected} c={c} board={board}
    eyebrow={<><Icon name="Folder" size={12} color={c.foregroundMuted}/><Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:11,flexShrink:1}}>{projectName(task)}</Text></>}
    accessory={<Pressable ref={statusAnchor} accessibilityRole="button" accessibilityLabel={`Open task details, status ${taskStateLabel(task)}`} onHoverIn={()=>setStatusTip(true)} onHoverOut={()=>setStatusTip(false)} onFocus={()=>setStatusTip(true)} onBlur={()=>setStatusTip(false)} onPress={event=>{event.stopPropagation();onPress();}}
      style={{width:24,height:24,marginTop:-3,marginRight:-5,borderRadius:12,alignItems:'center',justifyContent:'center',backgroundColor:c.surface2,flexShrink:0,position:'relative'}}>
      <Icon name={phaseIcon(task)} size={12} color={cardAttention?c.statusWarning:c.foregroundMuted}/>
      {statusTip&&<Popover anchor={statusAnchor} align="end" pointerEvents="none" inlineStyle={{right:0,top:28}}><View pointerEvents="none" style={{paddingHorizontal:7,paddingVertical:4,borderRadius:6,borderWidth:1,borderColor:c.border,backgroundColor:c.surface2,shadowColor:'#000',shadowOffset:{width:0,height:3},shadowOpacity:0.3,shadowRadius:6,elevation:8}}><Text numberOfLines={1} style={{fontSize:11,fontWeight:'600',color:cardAttention?c.statusWarning:c.foreground}}>{taskStateLabel(task)}</Text></View></Popover>}
    </Pressable>}
    title={<Text numberOfLines={2} style={{ color: c.foreground, fontWeight: "600", fontSize: board ? 13 : 14, lineHeight:17 }}>{[taskNumberLabel(task, false), task.entrypoint==="review"?"Review entry":"", task.title].filter(Boolean).join(" · ")}</Text>}
    chips={hasChips?<View style={{...row,gap:6,flexWrap:'wrap'}}>{parked&&<RecordChips c={c} chips={['parked']}/>}<InteractiveBadge task={task} c={c}/>{task.parked&&<Badge label="Parked (no slot held)" tone="warning" c={c} a11y="Parked (no slot held)"/>}{task.pausedStop&&<Badge label="Stopped while paused" tone="warning" c={c} a11y="Stopped while Nucleus was paused; Nucleus resumes it when the queue starts"/>}<HoldChips task={task} c={c} decisionTitle={decisionTitle}/>{showStopBadge&&<StopBadge task={task} c={c}/>}{budgetExhausted&&<BudgetBadge task={task} c={c}/>}{decisions&&<Badge label="Decision" tone={recordBadgeTone("decision")} c={c} a11y="Open decisions linked"/>}</View>:undefined}
    snippet={<View style={{gap:3}}>
      <Text numberOfLines={1} style={{color:attentionPriority?c.statusWarning:c.foreground,fontSize:12,fontWeight:'600'}}>{phaseStateLabel(task)}</Text>
      {next}
    </View>}
    footer={hasFooter?<View style={{...row,gap:6,flexWrap:'nowrap'}}>
      {task.queuePriority>0&&<View accessible accessibilityLabel="Promoted in project"><Icon name="ArrowUpToLine" size={12} color={c.foregroundMuted}/></View>}
      {task.dependsOn.length>0&&<View accessible accessibilityLabel={`${task.dependsOn.length} prerequisite${task.dependsOn.length===1?'':'s'}`} style={{flexDirection:'row',alignItems:'center',gap:3,flexShrink:0}}><Icon name="Link" size={12} color={c.foregroundMuted}/><Text style={{...muted(c),fontSize:11}}>{task.dependsOn.length}</Text></View>}
      <View style={{flex:1}}/>
      {task.prUrl&&<PullRequestBadge task={task} state={prState} c={c} small/>}</View>:undefined} />;
});
/**
 * Spec 032: an agent's open decision in the Pipeline Decisions column. The card carries the
 * question, the asker, the age and the recommendation; answering and withdrawing
 * happen in the modal, never on the card. A stale decision stays visible.
 */
export function decisionChoicePresentation(decision: DecisionView) {
  const raw = decision.choices ?? decision.options.slice(0, 3).map(label => ({ label, consequence: "" }));
  const recommended = decision.recommended ?? decision.options[0] ?? raw[0]?.label;
  const first = raw.find(choice => choice.label === recommended);
  return { choices: first ? [first, ...raw.filter(choice => choice !== first)] : raw, recommended };
}
export const DecisionCard = React.memo(function DecisionCard({decision,selected,onPress,c,board=true,linkedTaskProjects=[],linkedTaskLabels=[]}:{decision:DecisionView;selected:boolean;onPress:()=>void;c:Colors;board?:boolean;linkedTaskProjects?:string[];linkedTaskLabels?:string[]}) {
  const links = decision.links.tasks.length + decision.links.leads.length + decision.links.papercuts.length;
  const {choices, recommended} = decisionChoicePresentation(decision);
  const headline = decision.headline ?? decision.question;
  return <BoardCard label={`Decision: ${headline}`} onPress={onPress} selected={selected} c={c} board={board}
    eyebrow={<><Icon name="Folder" size={12} color={c.foregroundMuted}/><Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:11,flexShrink:1}}>{decisionProjectLabel(decision)}</Text></>}
    title={<Text numberOfLines={2} style={{color:c.foreground,fontWeight:"600",fontSize:13,lineHeight:17}}>{headline}</Text>}
    chips={<RecordChips c={c} chips={["Decision", ...(decision.stale ? ["Stale"] : []), ...((decision.overtakenBy?.length ?? 0) > 0 ? ["Probably overtaken"] : [])]}/>}
    snippet={choices.length || linkedTaskProjects.length || decision.links.tasks.length ? <View style={{gap:3}}>
      {choices.map(choice => <Text key={choice.label} numberOfLines={1} ellipsizeMode="tail" style={{color:c.foregroundMuted,fontSize:12,lineHeight:16}}>{choice.label === recommended ? "★ Recommended · " : ""}{choice.label}{choice.consequence ? ` — ${choice.consequence}` : ""}</Text>)}
      {linkedTaskLabels.length > 0 && <Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:11}}>Task · {linkedTaskLabels.join(", ")}</Text>}
      {isGeneralDecision(decision) && linkedTaskProjects.length > 0 && <Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:11}}>linked: {linkedTaskProjects.join(', ')}</Text>}
    </View> : undefined}
    footer={<Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:11,flex:1,minWidth:0}}>Asked {decisionAge(decision.createdAt)}{links?` · ${links} link${links===1?"":"s"}`:""}</Text>} />;
});
/**
 * Spec 032: Queue's own escalation — a task in needs_attention or carrying an
 * escalated incident or recovery — read-only in the Pipeline Decisions column. The card
 * carries no answer box; pressing it opens the task's own detail.
 */
function RaisedCard({task,selected,onPress,c,board=true}:{task:TaskSummary;selected:boolean;onPress:()=>void;c:Colors;board?:boolean}) {
  const held = task.holdEscalated && task.hold;
  return <BoardCard label={held ? `Ready to merge, held for ${task.hold!.reason}: ${task.title}` : `Nucleus-raised: ${task.title}, ${phaseLabel(task)}${task.holdKind ? `, ${holdKindLabel(task.holdKind)}` : ""}`} onPress={onPress} selected={selected} c={c} board={board}
    eyebrow={<><Icon name="Folder" size={12} color={c.foregroundMuted}/><Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:11,flexShrink:1}}>{projectName(task)}</Text></>}
    title={<Text numberOfLines={2} style={{color:c.foreground,fontWeight:"600",fontSize:13,lineHeight:17}}>{task.title}</Text>}
    chips={<View style={{...row,gap:6,flexWrap:'wrap'}}><RecordChips c={c} chips={["Nucleus-raised"]}/><Badge label={phaseLabel(task)} tone={phaseBadgeTone(task)} c={c} bold a11y={`Phase ${phaseLabel(task)}`}/>{presentHoldKinds(task).map(kind=><HoldBadge key={kind} kind={kind} c={c}/>)}<StopBadge task={task} c={c}/></View>}
    snippet={<Text numberOfLines={3} ellipsizeMode="tail" style={{color:c.foregroundMuted,fontSize:12,lineHeight:16}}>{held ? `Ready to merge, held for ${task.hold!.reason} since ${task.hold!.since ? new Date(task.hold!.since).toLocaleString() : "an unrecorded time"} · owner ${task.hold!.owner}` : task.reason}</Text>} />;
}
/**
 * Spec 040: an escalated merge hold carries operator authority, so it is the one Nucleus-raised
 * item with actions: Release continues the merge; Keep renews the hold and asks for a reason.
 */
export const HoldPromptCard = React.memo(function HoldPromptCard({task,selected,onPress,c,board=true,busy,onRelease,onKeep}:{task:TaskSummary;selected:boolean;onPress:()=>void;c:Colors;board?:boolean;busy:boolean;onRelease:()=>void;onKeep:(reason:string)=>void}) {
  const [keeping,setKeeping]=useState(false), [reason,setReason]=useState("");
  return <View accessibilityLabel={plainCardText(`Held merge: ${task.title}`)} style={{gap:6}}>
    <RaisedCard task={task} selected={selected} onPress={onPress} c={c} board={board}/>
    <View style={{...row,gap:6}}>
      <Button small c={c} disabled={busy} text="Release" onPress={onRelease}/>
      <Button small c={c} disabled={busy} text="Keep" selected={keeping} onPress={()=>setKeeping(!keeping)}/>
    </View>
    {keeping&&<View style={{gap:6}}>
      <Field c={c} label="Why keep the hold (required)" value={reason} onChange={setReason}/>
      <Button small c={c} disabled={busy||!reason.trim()} text="Keep hold" onPress={()=>{onKeep(reason.trim());setKeeping(false);setReason("");}}/>
    </View>}
  </View>;
});
/**
 * Spec 041: a drained lane that outlived its escalation timer is the operator's to answer.
 * Close finishes the step (lane.status done); Keep records a reason and ends the episode.
 */
export const LaneDrainCard = React.memo(function LaneDrainCard({lane,selected,onPress,c,board=true,busy,onClose,onKeep}:{lane:LaneView;selected:boolean;onPress:()=>void;c:Colors;board?:boolean;busy:boolean;onClose:()=>void;onKeep:(reason:string)=>void}) {
  const [keeping,setKeeping]=useState(false), [reason,setReason]=useState("");
  return <View accessibilityLabel={plainCardText(`Drained lane: ${lane.title}`)} style={{gap:6}}>
    <BoardCard label={`Drained lane: ${lane.title}`} onPress={onPress} selected={selected} c={c} board={board}
      eyebrow={<><Icon name="Folder" size={12} color={c.foregroundMuted}/><Text numberOfLines={1} ellipsizeMode="tail" style={{...muted(c),fontSize:11,flexShrink:1}}>{lane.key}</Text></>}
      title={<Text numberOfLines={2} style={{color:c.foreground,fontWeight:"600",fontSize:13,lineHeight:17}}>{lane.title} has drained</Text>}
      chips={<RecordChips c={c} chips={["Nucleus-raised"]}/>}
      snippet={<Text numberOfLines={3} ellipsizeMode="tail" style={{color:c.foregroundMuted,fontSize:12,lineHeight:16}}>{lane.aim}{lane.drain?.escalatedAt ? ` · escalated ${decisionAge(lane.drain.escalatedAt)}` : ""}</Text>}
      footer={<Text numberOfLines={1} style={{...muted(c),fontSize:11}}>The plan owner has not answered the close-out prompt</Text>} />
    <View style={{...row,gap:6}}>
      <Button small c={c} disabled={busy} text="Close" label={plainCardText(`Close drained lane ${lane.key}`)} onPress={onClose}/>
      <Button small c={c} disabled={busy} text="Keep" selected={keeping} label={plainCardText(`Keep drained lane ${lane.key}`)} onPress={()=>setKeeping(!keeping)}/>
    </View>
    {keeping&&<View style={{gap:6}}>
      <Field c={c} label={`Why keep ${lane.title} (required)`} value={reason} onChange={setReason}/>
      <Button small c={c} disabled={busy||!reason.trim()} text="Keep lane" label={plainCardText(`Confirm keep for drained lane ${lane.key}`)} onPress={()=>{onKeep(reason.trim());setKeeping(false);setReason("");}}/>
    </View>}
  </View>;
});
