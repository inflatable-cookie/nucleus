import React, { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, Icon } from "./shell";
import { Button, DetailSection, Disclosure, DropdownSelect, FieldCaption, LabelHelp, controlFrame, controlText, muted, row, type Colors } from "./controls";
import { control, space } from "./design";
import * as api from "../shared/contracts";
import { formatTelemetryDuration, STAGE_META, type TelemetrySnapshot } from "../shared/telemetry";
import { Metric } from "./telemetry-parts";
function ProjectFilter({ projects, value, onChange, c }: { projects: { path: string; name: string }[]; value: string; onChange: (path: string) => void; c: Colors }) {
  const [open, setOpen] = useState(false);
  const label = value ? projects.find(project => project.path === value)?.name ?? "All projects" : "All projects";
  return <View style={{ minWidth: 210, maxWidth: "100%", position: "relative", zIndex: open ? 20 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Project filter, ${label}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
      style={{ ...controlFrame(c, { focused: open }), flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 }}><Icon name="Folder" size={14} color={value ? c.accent : c.foregroundMuted} />
        <Text numberOfLines={1} style={{ ...controlText(c), flexShrink: 1 }}>{label}</Text></View>
      <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
    </Pressable>
    {open && <ScrollView accessibilityRole="menu" nestedScrollEnabled style={{ position: "absolute", top: control.height + space.xxs, left: 0, right: 0, maxHeight: 320, borderWidth: 1, borderColor: c.border, borderRadius: 7, backgroundColor: c.surface1,
      shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 14, elevation: 12 }}>
      {[{ path: "", name: "All projects" }, ...projects].map(project => <Pressable key={project.path || "all"} accessibilityRole="menuitem" accessibilityLabel={`Project: ${project.name}`} accessibilityState={{ selected: value === project.path }}
        onPress={() => { onChange(project.path); setOpen(false); }} style={{ minHeight: control.height, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: control.paddingX, backgroundColor: value === project.path ? c.surface2 : c.surface1 }}>
        <Icon name={value === project.path ? "Check" : "Folder"} size={14} color={value === project.path ? c.accent : c.foregroundMuted} />
        <Text numberOfLines={1} style={controlText(c)}>{project.name}</Text>
      </Pressable>)}
    </ScrollView>}
  </View>;
}
function HeadlineMetric({label,category,c}:{label:string;category:{taskCount:number;factCount:number;rate:number|null};c:Colors}) {
  const share=category.rate===null?"—":`${Math.round(category.rate*100)}%`;
  return <View style={{gap:2,minWidth:140}}><Text style={{...muted(c),fontSize:10,textTransform:"uppercase"}}>{label}</Text>
    <Text style={{color:c.foreground,fontSize:15,fontWeight:"600"}}>{share} <Text style={{...muted(c),fontSize:11}}>· {category.taskCount} {category.taskCount===1?"task":"tasks"}</Text></Text>
    <Text style={{...muted(c),fontSize:10}}>{category.factCount} {category.factCount===1?"fact":"facts"}</Text></View>;
}
function ReviewerCalibrationSection({group,c}:{group:TelemetrySnapshot["groups"][number];c:Colors}) {
  const calibration=group.reviewerCalibration;
  const rate=(value:number|null)=>value===null?"—":`${Math.round(value*100)}%`;
  return <View accessibilityLabel={`Reviewer calibration for ${group.label}`} style={{gap:6}}>
    <LabelHelp c={c} label="Reviewer calibration" text="Evidence, not quality scores. Reviewer dimensions stay separate from worker routing." />
    <View style={{...row,gap:20,alignItems:"flex-start"}}>
      <Metric c={c} label="Verdicts" value={`${calibration.verdicts}`} mutedValue={calibration.verdicts===0}/>
      <Metric c={c} label="Approved / changes" value={`${calibration.approved} / ${calibration.changesRequired}`}/>
      <Metric c={c} label="Revision returns" value={`${calibration.revisionRounds} · ${rate(calibration.revisionReturnRate)}`}/>
      <Metric c={c} label="Resolved rounds" value={`${calibration.resolvedRounds} · ${rate(calibration.resolutionRate)}`}/>
      <Metric c={c} label="Pre-merge refusals" value={`${calibration.preMergeRefusals} · ${rate(calibration.refusalRate)}`}/>
      <Metric c={c} label="Post-merge incidents" value={`${calibration.postMergeIncidents}`} mutedValue={calibration.postMergeIncidents===0}/>
    </View>
    <LabelHelp c={c} label={`${calibration.postMergeIncidents} post-merge incidents`} text={`${calibration.postMergeSemanticIncidents} semantic · ${calibration.postMergeOperationalIncidents} operational. Rates count distinct exact-head verdicts and rounds only, so they stay at or under one verdict; ${calibration.partialVerdicts} of ${calibration.verdicts} verdicts lack the exact-head or reviewer edge and stay out of the denominators${calibration.partialRevisionRounds?` · ${calibration.partialRevisionRounds} revision rounds reconstruct partially`:""}. A round resolves only when the next recorded verdict is an accepted re-review.`} />
    {calibration.reviewers.map(reviewer=><Text key={reviewer.key} style={{...muted(c),fontSize:11}}>Reviewer · {reviewer.label} · {reviewer.provider??"unknown provider"}{reviewer.model?` / ${reviewer.model}`:""}{reviewer.profileGroup?` / ${reviewer.profileGroup}`:""} · verdicts {reviewer.verdicts} ({reviewer.approved} approved, {reviewer.changesRequired} changes required) · revision rounds {reviewer.revisionRounds} · resolved {reviewer.resolvedRounds} · refusals {reviewer.preMergeRefusals} · post-merge incidents {reviewer.postMergeIncidents}</Text>)}
    {calibration.omittedReviewers > 0 && <Text style={{...muted(c),fontSize:11}}>{calibration.omittedReviewers} reviewer rows omitted; filter to inspect a reviewer.</Text>}
  </View>;
}

/** Round 4: how often task controls apply, by source; the target is coordinator refusals under 10%. */
function TaskControlSection({controls,c}:{controls:TelemetrySnapshot["controls"];c:Colors}) {
  const rate=(value:number|null)=>value===null?"—":`${Math.round(value*100)}%`;
  const total=(side:typeof controls.owner)=>side.applied+side.refused;
  return <DetailSection title="Task controls" c={c}>
    <View accessibilityLabel="Task control outcomes" style={{...row,gap:20,alignItems:"flex-start"}}>
      <Metric c={c} label="Owner applied / refused" value={`${controls.owner.applied} / ${controls.owner.refused}`} mutedValue={total(controls.owner)===0}/>
      <Metric c={c} label="Owner refusal rate" value={rate(controls.owner.refusalRate)}/>
      <Metric c={c} label="Coordinator applied / refused" value={`${controls.coordinator.applied} / ${controls.coordinator.refused}`} mutedValue={total(controls.coordinator)===0}/>
      <Metric c={c} label="Coordinator refusal rate" value={rate(controls.coordinator.refusalRate)}/>
    </View>
    <LabelHelp c={c} label={`Last ${controls.windowDays} day${controls.windowDays===1?"":"s"}`} text="Every owner control and coordinator action. Outcomes are kept 30 days. Target: coordinator refusals under 10%." />
    {controls.byAction.length>0&&<Text style={{...muted(c),fontSize:11}}>{controls.byAction.map(item=>`${item.source==="owner"?"Owner":"Coordinator"} ${item.action.replaceAll("_"," ")} ${item.applied}/${item.refused}`).join(" · ")}</Text>}
    {controls.topRefusals.map(item=><Text key={`${item.source}-${item.action}-${item.reason}`} selectable style={{...muted(c),fontSize:11}}>Refused · {item.source} · {item.action.replaceAll("_"," ")} · {item.count} · {item.reason}</Text>)}
  </DetailSection>;
}

function TelemetryPanel({data,c,compact,repoPath,setRepoPath,window,setWindow,groupBy,setGroupBy,scope,setScope,profileGroup,setProfileGroup,closeoutAuthority,setCloseoutAuthority,createdAfter,setCreatedAfter,interventionRole,setInterventionRole,interventionProvider,setInterventionProvider,reviewerProvider,setReviewerProvider,reviewerProfile,setReviewerProfile,reviewerProfileGroup,setReviewerProfileGroup}:{
  data?:TelemetrySnapshot;c:Colors;compact:boolean;repoPath:string;setRepoPath:(value:string)=>void;window:"24h"|"7d"|"30d"|"90d"|"all";setWindow:(value:"24h"|"7d"|"30d"|"90d"|"all")=>void;
  groupBy:"none"|"repository"|"scope"|"profile_group"|"closeout_authority";setGroupBy:(value:"none"|"repository"|"scope"|"profile_group"|"closeout_authority")=>void;scope:string;setScope:(value:string)=>void;profileGroup:string;setProfileGroup:(value:string)=>void;
  closeoutAuthority:string;setCloseoutAuthority:(value:string)=>void;createdAfter:string;setCreatedAfter:(value:string)=>void;
  interventionRole:string;setInterventionRole:(value:string)=>void;interventionProvider:string;setInterventionProvider:(value:string)=>void;
  reviewerProvider:string;setReviewerProvider:(value:string)=>void;reviewerProfile:string;setReviewerProfile:(value:string)=>void;reviewerProfileGroup:string;setReviewerProfileGroup:(value:string)=>void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const projects=(data?.repositories??[]).map(path=>({path,name:path.split(/[\\/]/).filter(Boolean).at(-1)??path}));
  const groupOptions=[{value:"none",label:"No grouping"},{value:"repository",label:"Repository"},{value:"scope",label:"Scope"},{value:"profile_group",label:"Provider group"},{value:"closeout_authority",label:"Closeout authority"}];
  const scopeOptions=[{value:"",label:"All scopes"},...(data?.scopes??[]).map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))];
  const profileGroupOptions=[{value:"",label:"All provider groups"},...(data?.profileGroups??[]).map(value=>({value,label:value}))];
  const closeoutOptions=[{value:"",label:"All closeout methods"},{value:"repository_hook",label:"Repository hook"},{value:"agent",label:"Agent"},{value:"pending",label:"Pending"},{value:"none",label:"Unavailable history"}];
  const roleOptions=[{value:"",label:"All incident roles"},...(["worker","reviewer","coordinator","closeout","unknown"] as const).map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))];
  const providerOptions=[{value:"",label:"All incident providers"},...(data?.interventionProviders??[]).map(value=>({value,label:value}))];
  const reviewerProviderOptions=[{value:"",label:"All reviewer providers"},...(data?.reviewerProviders??[]).map(value=>({value,label:value}))];
  const reviewerProfileOptions=[{value:"",label:"All reviewer profiles"},...(data?.reviewerProfiles??[]).map(value=>({value,label:value}))];
  const reviewerProfileGroupOptions=[{value:"",label:"All reviewer groups"},...(data?.reviewerProfileGroups??[]).map(value=>({value,label:value}))];
  return <ScrollView style={{flex:1,minHeight:0}} contentContainerStyle={{gap:12,paddingBottom:20}}>
    <View style={{...row,alignItems:"flex-start"}}><ProjectFilter projects={projects} value={repoPath} onChange={setRepoPath} c={c}/>
      <View style={{...row,flex:1}}>{(["24h","7d","30d","90d","all"] as const).map(value=><Button key={value} small c={c} text={value} selected={window===value} onPress={()=>setWindow(value)}/>)}</View></View>
    <Disclosure c={c} label="More filters" expanded={advanced} onToggle={() => setAdvanced(!advanced)} />
    {advanced && <View style={{...row,alignItems:"flex-start",gap:12,zIndex:10}}>
      <DropdownSelect c={c} label="Group results" value={groupBy} options={groupOptions} onChange={value=>setGroupBy(value as typeof groupBy)} minWidth={180}/>
      <DropdownSelect c={c} label="Scope" value={scope} options={scopeOptions} onChange={setScope}/>
      <DropdownSelect c={c} label="Worker profile group" value={profileGroup} options={profileGroupOptions} onChange={setProfileGroup} minWidth={190}/>
      <DropdownSelect c={c} label="Closeout" value={closeoutAuthority} options={closeoutOptions} onChange={setCloseoutAuthority} minWidth={190}/>
      <DropdownSelect c={c} label="Incident role" value={interventionRole} options={roleOptions} onChange={setInterventionRole} minWidth={170}/>
      <DropdownSelect c={c} label="Incident provider" value={interventionProvider} options={providerOptions} onChange={setInterventionProvider} minWidth={180}/>
      <DropdownSelect c={c} label="Reviewer provider" value={reviewerProvider} options={reviewerProviderOptions} onChange={setReviewerProvider} minWidth={180}/>
      <DropdownSelect c={c} label="Reviewer profile" value={reviewerProfile} options={reviewerProfileOptions} onChange={setReviewerProfile} minWidth={180}/>
      <DropdownSelect c={c} label="Reviewer profile group" value={reviewerProfileGroup} options={reviewerProfileGroupOptions} onChange={setReviewerProfileGroup} minWidth={190}/>
      <View style={{gap:space.xxs,minWidth:260}}><FieldCaption c={c} text="Cohort created after"/><TextInput accessibilityLabel="Cohort created after" value={createdAfter} onChangeText={setCreatedAfter} placeholder="ISO timestamp with timezone" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={{...controlFrame(c,{invalid:Boolean(createdAfter)&&Number.isNaN(Date.parse(createdAfter))}),...controlText(c)}}/></View>
    </View>}
    {createdAfter && Number.isNaN(Date.parse(createdAfter)) && <Text accessibilityRole="alert" style={{color:c.statusWarning}}>Enter a valid date and time for the cohort filter.</Text>}
    <Text style={{...muted(c),fontSize:12}}>{data ? `${data.matchingTasks} matching tasks` : "Loading telemetry…"}</Text>
    {data && <Disclosure c={c} label="Task control history and refusal reasons" expanded={controlsOpen} onToggle={() => setControlsOpen(!controlsOpen)} />}
    {data && controlsOpen && <TaskControlSection controls={data.controls} c={c}/>}
    {data && (data.omittedGroups > 0 || data.truncatedDimensions.length > 0) && <Text style={{...muted(c),fontSize:12}}>Showing up to 100 groups and filter values. {data.omittedGroups} groups omitted; filter by repository or use a narrower window for detail.</Text>}
    {data?.groups.map(group=><DetailSection key={group.key} title={group.label} c={c}>
      <View style={{...row,gap:20,alignItems:"flex-start"}}>
        <Metric c={c} label="Tasks" value={String(group.taskCount)}/>
        <Metric c={c} label="Finished" value={group.completionRate===null?"Not available":`${Math.round(group.completionRate*100)}%`}/>
        <Metric c={c} label="Needed help" value={group.interventionRate===null?"Not available":`${Math.round(group.interventionRate*100)}%`}/>
      </View>
      <Disclosure c={c} label="Technical detail" expanded={technical} onToggle={() => setTechnical(!technical)} />
      {technical && <>
      <View style={{...row,gap:20,alignItems:"flex-start"}}>
      <Metric c={c} label="Tasks" value={String(group.taskCount)}/><Metric c={c} label="Completed" value={group.completionRate===null?"—":`${Math.round(group.completionRate*100)}%`}/><Metric c={c} label="Intervention" value={group.interventionRate===null?"—":`${Math.round(group.interventionRate*100)}%`}/>
      <Metric c={c} label="Total p50 / p95" value={group.total.p50Ms===null?"—":`${formatTelemetryDuration(group.total.p50Ms)} / ${formatTelemetryDuration(group.total.p95Ms??0)}`}/><Metric c={c} label="Wait p50 / p95" value={group.waiting.p50Ms===null?"—":`${formatTelemetryDuration(group.waiting.p50Ms)} / ${formatTelemetryDuration(group.waiting.p95Ms??0)}`}/><Metric c={c} label="Active p50 / p95" value={group.active.p50Ms===null?"—":`${formatTelemetryDuration(group.active.p50Ms)} / ${formatTelemetryDuration(group.active.p95Ms??0)}`}/></View>
      <View accessibilityLabel={`Headline categories for ${group.label}`} style={{...row,gap:20,alignItems:"flex-start"}}>
        <HeadlineMetric c={c} label="Delivery exceptions" category={group.headline.deliveryExceptions}/>
        <HeadlineMetric c={c} label="Semantic review" category={group.headline.semanticReview}/>
        <HeadlineMetric c={c} label="Operator administration" category={group.headline.operatorAdministration}/></View>
      <LabelHelp c={c} label="Headline categories" text="Each counts tasks with at least one fact of that class; a task may appear in more than one. Raw counters and the legacy intervention rate still include every overlapping fact." />
      <Text style={{...muted(c),fontSize:11}}>{group.evidence === "exact" ? "Exact transition evidence" : `${group.total.partialCount}/${group.total.count} tasks use partial historical reconstruction`}</Text>
      <View style={{gap:5}}>{group.stages.map(stage=><View key={stage.stage} style={{...row,flexWrap:"nowrap",justifyContent:"space-between",paddingVertical:4,borderBottomWidth:1,borderBottomColor:c.border}}><Text style={{color:c.foreground,fontSize:12,flex:1}}>{STAGE_META[stage.stage].label}{stage.supplemental?" · nested":""}</Text><Text style={{...muted(c),fontSize:11}}>{stage.count} · p50 {stage.p50Ms===null?"—":formatTelemetryDuration(stage.p50Ms)} · p95 {stage.p95Ms===null?"—":formatTelemetryDuration(stage.p95Ms)}{stage.partialCount?` · ${stage.partialCount} partial`:""}</Text></View>)}</View>
      <Text style={{...muted(c),fontSize:12}}>Recoveries {group.interventions.recoveryRuns} · hook retries {group.interventions.hookRetries} · hook holds {group.interventions.hookHolds} · automatic hook replays {group.interventions.automaticHookReplays} · prospective-merge hooks {group.interventions.prospectiveMergeHooks} · stale candidates {group.interventions.staleCandidateRebuilds} · review revisions {group.interventions.revisions} · administrative revisions {group.interventions.administrativeRevisions} · replacements {group.interventions.replacements} · escalations {group.interventions.escalations}</Text>
      <Text style={{...muted(c),fontSize:12}}>Closeout authority · repository hook {group.closeoutAuthorities.repositoryHook} · agent {group.closeoutAuthorities.agent} · pending {group.closeoutAuthorities.pending} · unavailable history {group.closeoutAuthorities.none}</Text>
      {group.qaAdmission.validations>0&&<View accessibilityLabel={`Nucleus scheduler validation telemetry for ${group.label}`} style={{gap:5}}>
        <Text style={{color:c.foreground,fontSize:12,fontWeight:'600'}}>Nucleus scheduler validation telemetry · {group.qaAdmission.validations} validation{group.qaAdmission.validations===1?"":"s"}</Text>
        <View style={{...row,gap:20,alignItems:"flex-start"}}>
          <Metric c={c} label="queue wait p50 / p95" value={group.qaAdmission.queueWaitMs.p50Ms===null?"—":`${formatTelemetryDuration(group.qaAdmission.queueWaitMs.p50Ms)} / ${formatTelemetryDuration(group.qaAdmission.queueWaitMs.p95Ms??0)}`}/>
          <Metric c={c} label="Wall p50 / p95" value={group.qaAdmission.wallMs.p50Ms===null?"—":`${formatTelemetryDuration(group.qaAdmission.wallMs.p50Ms)} / ${formatTelemetryDuration(group.qaAdmission.wallMs.p95Ms??0)}`}/>
          <Metric c={c} label="CPU p50" value={group.qaAdmission.cpuMs.p50Ms===null?"—":formatTelemetryDuration(group.qaAdmission.cpuMs.p50Ms)}/>
          <Metric c={c} label="Capacity holds" value={String(group.qaAdmission.capacityUnavailable)}/></View>
        <LabelHelp c={c} label="Queue wait and CPU" text={`The queue wait comes from Nucleus's scheduler record and is reported separately from wall run time. Unavailable values are never counted as zero.${group.qaAdmission.cpuMs.partialCount>0?` ${group.qaAdmission.cpuMs.partialCount} validation${group.qaAdmission.cpuMs.partialCount===1?"":"s"} without CPU measures.`:""}`} />
      </View>}
      <ReviewerCalibrationSection group={group} c={c}/>
      <LabelHelp c={c} label={`Shadow review ${data?.shadowPlan.enabled?"on":"off"}`} text={`Experiment, non-authoritative and read-only: one shadow per sampled task, daily cap ${data?.shadowPlan.dailyCap??5}, sample rate at most ${Math.round((data?.shadowPlan.maxSampleRate??0.1)*100)}%. Enabling needs a separate operator decision.`} />
      {group.interventions.recoveries.map(item=><Text key={`${item.targetRole}-${item.provider}-${item.profileGroup}-${item.status}-${item.cause}`} style={{...muted(c),fontSize:11}}>Recovery · {item.targetRole} · {item.provider??"unknown provider"}{item.profileGroup?` / ${item.profileGroup}`:""} · {item.status} · {item.cause.replaceAll("_"," ")} · {item.count}</Text>)}
      {group.interventions.incidents.map(item=><Text key={`${item.role}-${item.provider}-${item.profileGroup}-${item.cause}`} style={{...muted(c),fontSize:11}}>Incident · {item.role} · {item.provider??"unknown provider"}{item.profileGroup?` / ${item.profileGroup}`:""} · {item.cause.replaceAll("_"," ")} · {item.count}</Text>)}
      </>}
    </DetailSection>)}
    {data&&!data.groups.length&&<Text style={muted(c)}>No task activity matches these filters.</Text>}
  </ScrollView>;
}


export function SettingsTelemetry({c, compact}: {c: Colors; compact: boolean}) {
  const fetchTelemetry = useRpc(api.telemetry);
  const [telemetryRepo,setTelemetryRepo]=useState(""),[telemetryWindow,setTelemetryWindow]=useState<"24h"|"7d"|"30d"|"90d"|"all">("24h"),[telemetryGroup,setTelemetryGroup]=useState<"none"|"repository"|"scope"|"profile_group"|"closeout_authority">("none");
  const [telemetryScope,setTelemetryScope]=useState(""),[telemetryProfileGroup,setTelemetryProfileGroup]=useState("");
  const [telemetryCloseout,setTelemetryCloseout]=useState("");
  const [telemetryCreatedAfter,setTelemetryCreatedAfter]=useState(""),[telemetryInterventionRole,setTelemetryInterventionRole]=useState(""),[telemetryInterventionProvider,setTelemetryInterventionProvider]=useState("");
  const [telemetryReviewerProvider,setTelemetryReviewerProvider]=useState(""),[telemetryReviewerProfile,setTelemetryReviewerProfile]=useState(""),[telemetryReviewerProfileGroup,setTelemetryReviewerProfileGroup]=useState("");
  const validTelemetryCreatedAfter=telemetryCreatedAfter&&!Number.isNaN(Date.parse(telemetryCreatedAfter))?new Date(telemetryCreatedAfter).toISOString():"";
  const telemetryQuery = useQuery({
    queryKey: [
      "nucleus",
      "telemetry",
      telemetryRepo,
      telemetryWindow,
      telemetryGroup,
      telemetryScope,
      telemetryProfileGroup,
      telemetryCloseout,
      validTelemetryCreatedAfter,
      telemetryInterventionRole,
      telemetryInterventionProvider,
      telemetryReviewerProvider,
      telemetryReviewerProfile,
      telemetryReviewerProfileGroup,
    ],
    queryFn: () =>
      fetchTelemetry({
        window: telemetryWindow,
        groupBy: telemetryGroup,
        ...(telemetryRepo ? { repoPath: telemetryRepo } : {}),
        ...(telemetryScope
          ? { scope: telemetryScope as "general" | "mechanical" | "complex" }
          : {}),
        ...(telemetryProfileGroup
          ? { profileGroup: telemetryProfileGroup }
          : {}),
        ...(telemetryCloseout
          ? {
              closeoutAuthority: telemetryCloseout as
                | "repository_hook"
                | "agent"
                | "pending"
                | "none",
            }
          : {}),
        ...(validTelemetryCreatedAfter
          ? { createdAfter: validTelemetryCreatedAfter }
          : {}),
        ...(telemetryInterventionRole
          ? {
              interventionRole: telemetryInterventionRole as
                | "worker"
                | "reviewer"
                | "coordinator"
                | "closeout"
                | "unknown",
            }
          : {}),
        ...(telemetryInterventionProvider
          ? { interventionProvider: telemetryInterventionProvider }
          : {}),
        ...(telemetryReviewerProvider
          ? { reviewerProvider: telemetryReviewerProvider }
          : {}),
        ...(telemetryReviewerProfile
          ? { reviewerProfile: telemetryReviewerProfile }
          : {}),
        ...(telemetryReviewerProfileGroup
          ? { reviewerProfileGroup: telemetryReviewerProfileGroup }
          : {}),
      }),
    enabled: true,
    refetchInterval: false,
  });
  if (telemetryQuery.error && !telemetryQuery.data) return <View style={{gap: 8}}><Text accessibilityRole="alert" style={{color:c.statusDanger}}>Could not load telemetry: {String(telemetryQuery.error)}</Text><Button small c={c} text="Retry" label="Retry loading telemetry" onPress={() => void telemetryQuery.refetch()} /></View>;
  return <View style={{flex:1, minHeight:0}}>
    {telemetryQuery.error && <View style={{gap:8}}><Text accessibilityRole="alert" style={{color:c.statusWarning}}>Telemetry refresh failed; showing the last result: {String(telemetryQuery.error)}</Text><Button small c={c} text="Retry" label="Retry refreshing telemetry" onPress={() => void telemetryQuery.refetch()} /></View>}
        <TelemetryPanel
          data={telemetryQuery.data}
          c={c}
          compact={compact}
          repoPath={telemetryRepo}
          setRepoPath={setTelemetryRepo}
          window={telemetryWindow}
          setWindow={setTelemetryWindow}
          groupBy={telemetryGroup}
          setGroupBy={setTelemetryGroup}
          scope={telemetryScope}
          setScope={setTelemetryScope}
          profileGroup={telemetryProfileGroup}
          setProfileGroup={setTelemetryProfileGroup}
          closeoutAuthority={telemetryCloseout}
          setCloseoutAuthority={setTelemetryCloseout}
          createdAfter={telemetryCreatedAfter}
          setCreatedAfter={setTelemetryCreatedAfter}
          interventionRole={telemetryInterventionRole}
          setInterventionRole={setTelemetryInterventionRole}
          interventionProvider={telemetryInterventionProvider}
          setInterventionProvider={setTelemetryInterventionProvider}
          reviewerProvider={telemetryReviewerProvider}
          setReviewerProvider={setTelemetryReviewerProvider}
          reviewerProfile={telemetryReviewerProfile}
          setReviewerProfile={setTelemetryReviewerProfile}
          reviewerProfileGroup={telemetryReviewerProfileGroup}
          setReviewerProfileGroup={setTelemetryReviewerProfileGroup}
        />
  </View>;
}
