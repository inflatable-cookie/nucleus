import { Text, View } from "react-native";
import { DetailSection, muted, row, type Colors } from "./controls";
import type { Task } from "../shared/contracts";
import { compactTelemetrySummary, formatTelemetryDuration, STAGE_META, type TaskTelemetry } from "../shared/telemetry";

export function Metric({label,value,c,mutedValue=false}:{label:string;value:string;c:Colors;mutedValue?:boolean}) {
  return <View style={{gap:2,minWidth:92}}><Text style={{...muted(c),fontSize:10,textTransform:"uppercase"}}>{label}</Text><Text style={{color:mutedValue?c.foregroundMuted:c.foreground,fontSize:15,fontWeight:"600"}}>{value}</Text></View>;
}
const schedulerMs = (value: number | null) => value === null ? "unavailable" : `${Math.round(value / 100) / 10}s`;
/** Project validation result and telemetry from Queue's host scheduler. */
export function ProjectValidationSection({task,c}:{task:Task;c:Colors}) {
  const validation=task.resolution.projectValidation;
  if(!validation) return null;
  const hostRun=validation.hostRunTelemetry;
  return <DetailSection title="Project validation" c={c}>
    <Text style={{color:c.foreground,fontSize:12}}>{validation.state}{validation.exitCode!==null?` · exit ${validation.exitCode}`:""}{validation.durationMs?` · ran ${formatTelemetryDuration(validation.durationMs)}`:""}{validation.capacityUnavailable?" · QA capacity unavailable":validation.capacityWait?" · waiting for QA capacity":""}</Text>
    {validation.capacityWait&&<Text accessibilityRole="alert" style={{color:c.statusWarning,fontSize:12}}>Waiting for QA capacity (position {validation.capacityWait.position}) — waiting is not a stall or a hang</Text>}
    {validation.capacityUnavailable&&<Text accessibilityRole="alert" style={{color:c.statusWarning,fontSize:12}}>QA capacity unavailable: the capacity deadline lapsed. Retry by operator; this is not a validation failure.</Text>}
    {hostRun&&<Text style={{...muted(c),fontSize:12}}>Nucleus scheduler · {hostRun.outcome??"settlement pending"} · queue wait {schedulerMs(hostRun.queueWaitMs)} · wall {schedulerMs(hostRun.wallMs)} · CPU {schedulerMs(hostRun.cpuMs)}</Text>}
    {Boolean(validation.outputTail)&&<Text selectable accessibilityLabel="Validation output tail" style={{...muted(c),fontSize:11}}>{validation.outputTail}</Text>}
  </DetailSection>;
}
export function CompactTelemetrySummary({telemetry,c}:{telemetry:TaskTelemetry;c:Colors}) {
  const summary=compactTelemetrySummary(telemetry);
  return <DetailSection title="Timing" c={c}><View style={{...row,gap:18,alignItems:"flex-start"}}>
    {summary.metrics.map(metric=><Metric key={metric.label} c={c} label={metric.label} value={metric.value} mutedValue={metric.label==="Interventions"&&metric.value==="0"}/>)}</View>
    <Text style={{...muted(c),fontSize:11}}>{summary.evidence}</Text>
    <View style={{...row,gap:6}}>{telemetry.stages.filter(stage=>stage.elapsedMs>0).map(stage=><View key={stage.stage} style={{paddingHorizontal:7,paddingVertical:4,borderRadius:6,backgroundColor:c.surface2}}><Text style={{color:c.foregroundMuted,fontSize:11}}>{STAGE_META[stage.stage].label} {formatTelemetryDuration(stage.elapsedMs)}{stage.partial?"*":""}</Text></View>)}</View>
    <Text accessibilityLabel="Task usage" style={{color:c.foregroundMuted,fontSize:12}}>Usage · {summary.usage.total}</Text>
    {summary.usage.lines.map(line=><Text key={line} style={{...muted(c),fontSize:11}}>{line}</Text>)}
    <Text style={{...muted(c),fontSize:11}}>{summary.usage.evidence}</Text>
    {telemetry.nonDelivery.count > 0 && <View accessibilityLabel="Task non-delivery telemetry" style={{gap:3}}>
      <Text style={{color:c.foregroundMuted,fontSize:12}}>Non-deliveries · {telemetry.nonDelivery.count}</Text>
      {telemetry.nonDelivery.byModel.map(item=><Text key={`${item.provider ?? 'unknown'}:${item.model ?? 'unknown'}`} style={{...muted(c),fontSize:11}}>
        {item.provider ?? 'Unknown provider'}/{item.model ?? 'unknown model'} · {item.count}
      </Text>)}
    </View>}
    {telemetry.blockers.count > 0 && <View accessibilityLabel="Task blocker ladder telemetry" style={{gap:3}}>
      <Text style={{color:c.foregroundMuted,fontSize:12}}>Blocked reports · {telemetry.blockers.count}</Text>
      {telemetry.blockers.byModel.map(item=><Text key={`${item.provider ?? 'unknown'}:${item.model ?? 'unknown'}`} style={{...muted(c),fontSize:11}}>
        {item.provider ?? 'Unknown provider'}/{item.model ?? 'unknown model'} · {item.count}
      </Text>)}
      <Text style={{...muted(c),fontSize:11}}>Ladder · worker {telemetry.blockers.escalations.worker} · reviewer {telemetry.blockers.escalations.reviewer} · planner {telemetry.blockers.escalations.planner} · Tom {telemetry.blockers.escalations.tom}</Text>
    </View>}
  </DetailSection>;
}
