import { errorText } from "./error-text";
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as api from '../shared/contracts';
import { ActionButton, Button, Dialog, Field, InlineConfirm, muted, row, type Colors } from './controls';
import { roles, space, touchTarget, type } from './design';
import { localStore } from './project-scope-controls';
import { withoutHostPaths } from './project-helpers';

const sessionCancellations=new Map<string,Cancellation|null>();
type Cancellation = { operationId:string; reason:string; digest:string; version:number; tasks:Array<{taskId:string;version:number}> };
type CancellationStorage = { getItem(key:string):string|null; setItem(key:string,value:string):void; removeItem?(key:string):void };
const savedKey=(key:string)=>`nucleus:project-removal:${key}`;
// Rows saved under the old plugin name stay readable; no new write uses it.
const legacySavedKey=(key:string)=>`northstar-queue:project-removal:${key}`;
export function readMigratedCancellation(storage:CancellationStorage|undefined,key:string):Cancellation|null {
  try {
    const current=storage?.getItem(savedKey(key));
    const legacy=current==null?storage?.getItem(legacySavedKey(key)):null;
    if(legacy!==null&&legacy!==undefined){storage?.setItem(savedKey(key),legacy);storage?.removeItem?.(legacySavedKey(key));}
    return JSON.parse(current??legacy??'null')??null;
  } catch { return null; }
}
const readCancellation=(key:string):Cancellation|null=>readMigratedCancellation(localStore(),key)??sessionCancellations.get(key)??null;
const saveCancellation=(key:string,value:Cancellation|null)=>{sessionCancellations.set(key,value);try{localStore()?.setItem(savedKey(key),JSON.stringify(value))}catch{/* Session identity still prevents a duplicate request. */}};
const message=(error:unknown)=>withoutHostPaths(errorText(error));

/** The one danger button's words: the effect it has. */
export function removalEffect(tasks:number):string {
  return tasks?`Cancel ${tasks} ${tasks===1?'task':'tasks'}`:'Delete project';
}

export type ProjectManagementApi = {
  previewRpc:(input:{key:string;target?:string})=>Promise<api.ProjectManagementPreview>;
  removeRpc:(input:api.ProjectManageInput)=>Promise<api.ProjectTombstone>;
  cancelRpc:(input:api.BulkDispositionRequest)=>Promise<api.BulkDisposition>;
  resetRpc:(input:{key:string;operationId:string;tasks:Array<{taskId:string;version:number}>})=>Promise<{reset:true}>;
  cancellationRpc:(input:{operationId:string})=>Promise<api.BulkDisposition>;
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
 * server preview; the danger button names its effect and asks once more, and a
 * new preview withdraws that confirmation. A cancellation's identity is saved
 * before it is sent, so an interrupted request is reconciled, never repeated.
 */
export function ProjectManagementView({project,c,onClose,onRemoved,rpc}:{rpc:ProjectManagementApi}&ProjectManagementProps) {
  const {previewRpc,removeRpc,cancelRpc,cancellationRpc,resetRpc}=rpc;
  const r=roles(c);
  const key=project.key;
  const [preview,setPreview]=useState<api.ProjectManagementPreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [reason,setReason]=useState(()=>readCancellation(key)?.reason??''),[confirming,setConfirming]=useState(false),[cancellation,setCancellation]=useState<Cancellation|null>(()=>readCancellation(key));
  const [batch,setBatch]=useState<api.BulkDisposition|null>(null),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let alive=true;setPreview(null);setError('');setConfirming(false);setLoading(true);
    void previewRpc({key}).then(value=>{if(alive){setPreview(value);if(value.cancellation){
      const batch=value.cancellation;setBatch(batch);
      const request={operationId:batch.operationId,reason:batch.reason,digest:value.digest,version:value.project.version,tasks:batch.items.map(item=>({taskId:item.taskId,version:item.initialVersion}))};
      setCancellation(current=>current??request);setReason(current=>current||batch.reason);saveCancellation(key,request);
    }}}).catch(err=>{if(alive)setError(message(err))}).finally(()=>{if(alive)setLoading(false)});
    return ()=>{alive=false};
  },[key,refresh]);
  useEffect(()=>{
    if (!cancellation) {setBatch(null);return}
    let alive=true;
    const poll=()=>void cancellationRpc({operationId:cancellation.operationId}).then(value=>{if(alive)setBatch(value)}).catch(err=>{if(alive)setError(`Cancellation receipt: ${message(err)}. No request was repeated.`)});
    poll();const timer=setInterval(poll,3000);return ()=>{alive=false;clearInterval(timer)};
  },[cancellation?.operationId]);
  const run=async()=>{
    setConfirming(false);
    if (!preview||!reason.trim()) return;
    setBusy(true);setError('');
    try {
      if (preview.tasks.length) {
        if (cancellation) throw new Error('A cancellation is still being reconciled. Refresh its receipt first.');
        const request:Cancellation={operationId:`project-removal-${key.slice(0,64)}-${Date.now()}-${Math.random().toString(36).slice(2)}`,reason:reason.trim(),digest:preview.digest,version:preview.project.version,tasks:preview.tasks};
        saveCancellation(key,request);setCancellation(request);
        // Save the identity before delivery so an interrupted request is never silently replayed.
        const result=await cancelRpc({operationId:request.operationId,tasks:request.tasks,action:'cancel',workDisposition:'preserve',reason:request.reason});
        setBatch(result);return;
      }
      if (cancellation && batch?.status!=='complete') throw new Error('Wait for the cancellation to finish.');
      await removeRpc({key,version:preview.project.version,digest:preview.digest,reason:reason.trim(),...(cancellation?{cancellationOperationId:cancellation.operationId}:{})});
      saveCancellation(key,null);onRemoved();
    }catch(err){setError(message(err))}finally{setBusy(false)}
  };
  const blocked=Boolean(preview?.items.some(item=>['qa','submission','operation'].includes(item.kind)));
  const overLimit=Boolean(preview&&preview.tasks.length>256);
  const waiting=Boolean(cancellation&&batch?.status!=='complete');
  const effect=removalEffect(preview?.tasks.length??0);
  const name=preview?.project.name??project.name;
  const unavailable=busy||loading||!preview||!reason.trim()||blocked||overLimit||waiting;
  const question=preview?.tasks.length?`Cancel ${preview.tasks.length===1?'its task':`its ${preview.tasks.length} tasks`}? Work is preserved.`
    :`Delete ${name}? Repository files and task history stay.`;
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
      <Text style={metadata(c)}>Open tasks are cancelled with work preserved; shared planning records listed here close too.</Text>
      {blocked&&<Text accessibilityRole="alert" style={{color:r.warning,...alert}}>Pending operations or QA must settle first. Nothing was removed.</Text>}
      {overLimit&&<Text accessibilityRole="alert" style={{color:r.warning,...alert}}>Over the 256-task cancellation limit. Cancel tasks through Nucleus first.</Text>}
    </View>}
    {cancellation&&<View style={{gap:space.xs}}>
      <Text accessibilityLiveRegion="polite" style={metadata(c)}>Cancellation {batch?.status??'checking receipt'}. Closing this dialog doesn't stop it.</Text>
      {!batch&&<View style={row}>
        <Button small c={c} text="Reconcile" label="Reconcile original cancellation" disabled={busy} onPress={()=>void cancelRpc({operationId:cancellation.operationId,tasks:cancellation.tasks,action:'cancel',workDisposition:'preserve',reason:cancellation.reason}).then(setBatch).catch(err=>setError(message(err)))}/>
        <Button small c={c} text="Reset" label="Reset a refused stale cancellation" disabled={busy} onPress={()=>void resetRpc({key,operationId:cancellation.operationId,tasks:cancellation.tasks}).then(()=>{saveCancellation(key,null);setCancellation(null);setRefresh(value=>value+1)}).catch(err=>setError(message(err)))}/>
      </View>}
      {batch?.items.filter(item=>item.error).map(item=><Text key={item.taskId} style={{color:r.danger,fontSize:type.metadata.fontSize,lineHeight:type.metadata.lineHeight}}>{item.taskId}: {withoutHostPaths(item.error!)}</Text>)}
      {batch?.status==='complete'&&<View style={row}><ActionButton c={c} action="refresh" label="Refresh final deletion preview" onPress={()=>setRefresh(value=>value+1)}/></View>}
    </View>}
    <Field c={c} label="Reason" value={reason} disabled={busy} onChange={setReason}/>
  </Dialog>;
}
