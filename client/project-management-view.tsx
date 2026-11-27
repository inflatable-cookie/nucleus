import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as api from '../shared/contracts';
import { errorText } from './error-text';
import { ActionButton, Button, Dialog, Field, InlineConfirm, muted, row, type Colors } from './controls';
import { roles, space, touchTarget, type } from './design';
import { withoutHostPaths } from './project-helpers';

const message=(error:unknown)=>withoutHostPaths(errorText(error));

/** Remove's preview and delete calls. The engine refuses removal while tasks are open (Spec 070). */
export type ProjectManagementApi = {
  previewRpc:(input:{key:string;target?:string})=>Promise<api.ProjectManagementPreview>;
  removeRpc:(input:api.ProjectManageInput)=>Promise<api.ProjectTombstone>;
};

export type ProjectManagementProps = {
  /** The project being removed; the dialog is scoped to it. */
  project:api.Project;
  c:Colors; onClose:()=>void;
  /** The project is gone. */
  onRemoved:()=>void;
};

const metadata=(c:Colors)=>({...muted(c),fontSize:type.metadata.fontSize,lineHeight:type.metadata.lineHeight});

/**
 * Remove (Spec 027; lane `nucleus-ui`, "Projects in Settings", build task 4): a
 * dialog behind the opened project's trash icon. It only removes; moving lives in
 * Move into (nucleus#969, #982). Every destructive choice is made from a fresh
 * server preview; the danger button asks once more, and a new preview withdraws
 * that confirmation. A project with open tasks is refused until they finish or
 * are cancelled through Nucleus.
 */
export function ProjectManagementView({project,c,onClose,onRemoved,rpc}:{rpc:ProjectManagementApi}&ProjectManagementProps) {
  const {previewRpc,removeRpc}=rpc;
  const r=roles(c);
  const key=project.key;
  const [preview,setPreview]=useState<api.ProjectManagementPreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [reason,setReason]=useState(''),[confirming,setConfirming]=useState(false);
  const [loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let alive=true;setPreview(null);setError('');setConfirming(false);setLoading(true);
    void previewRpc({key}).then(value=>{if(alive)setPreview(value)}).catch(err=>{if(alive)setError(message(err))}).finally(()=>{if(alive)setLoading(false)});
    return ()=>{alive=false};
  },[key,refresh]);
  const run=async()=>{
    setConfirming(false);
    if (!preview||!reason.trim()) return;
    setBusy(true);setError('');
    try {
      if (preview.tasks.length) return;
      await removeRpc({key,version:preview.project.version,digest:preview.digest,reason:reason.trim()});
      onRemoved();
    }catch(err){setError(message(err))}finally{setBusy(false)}
  };
  const blocked=Boolean(preview?.items.some(item=>['qa','submission','operation'].includes(item.kind)));
  const overLimit=Boolean(preview&&preview.tasks.length>256);
  const openTasks = preview?.tasks.length ?? 0;
  const refusingOpenTasks = openTasks > 0;
  const effect='Delete project';
  const name=preview?.project.name??project.name;
  const unavailable=busy||loading||!preview||!reason.trim()||blocked||overLimit||refusingOpenTasks;
  const question=`Delete ${name}? Repository files and task history stay.`;
  const alert={fontSize:type.body.fontSize,lineHeight:type.body.lineHeight};
  return <Dialog c={c} title={`Remove ${name}`} label={`Remove ${project.name} dialog`} closeLabel={`Close Remove ${project.name}`} closeDisabled={busy} onClose={onClose} bodyLabel="Remove project fields"
    footer={confirming
      ? <InlineConfirm c={c} question={question} confirmLabel={effect} label={project.name} busy={busy} onConfirm={()=>void run()} onCancel={()=>setConfirming(false)}/>
      : <View style={{...row,justifyContent:'flex-end',minHeight:touchTarget}}>
        <Button danger c={c} text={busy?'Working…':effect} label={effect} disabled={unavailable} onPress={()=>setConfirming(true)}/>
      </View>}>
    {error?<Text accessibilityRole="alert" style={{color:r.danger,...alert}}>{error}</Text>:null}
    {loading&&<Text accessibilityLiveRegion="polite" style={muted(c)}>Checking open work…</Text>}
    {preview&&<View style={{gap:space.xs}}>
      {/* Refresh sits by the count it refreshes, clear of the Close tooltip's corner. */}
      <View style={{...row,flexWrap:'nowrap'}}>
        <Text style={{color:r.foreground,fontWeight:'600',...alert,flexShrink:1,minWidth:0}}>{preview.items.length?`${preview.items.length} open ${preview.items.length===1?'record':'records'}`:'No open work'}</Text>
        <ActionButton c={c} action="refresh" label="Refresh open work" disabled={busy||loading} onPress={()=>setRefresh(value=>value+1)}/>
      </View>
      {preview.items.map(item=><Text key={`${item.kind}:${item.id}`} numberOfLines={2} style={metadata(c)}>{item.kind} · {item.label}{item.shared?' · shared':''}</Text>)}
      <Text style={metadata(c)}>{refusingOpenTasks
        ? 'Finish or cancel the open tasks before deleting this project.'
        : 'Deleting this project also deletes its planning records.'}</Text>
      {blocked&&<Text accessibilityRole="alert" style={{color:r.warning,...alert}}>Pending operations or QA must settle first. Nothing was removed.</Text>}
      {overLimit&&<Text accessibilityRole="alert" style={{color:r.warning,...alert}}>Over the 256-task cancellation limit. Cancel tasks through Nucleus first.</Text>}
    </View>}
    <Field c={c} label="Reason" value={reason} disabled={busy} onChange={setReason}/>
  </Dialog>;
}
