// One write at a time; edits made during a write replace the next pending value.
// A closure, not a class: Paseo compiles plugin clients with esbuild and Hermes
// evaluates them from source without Metro's class transform, so constructing a
// class failed on mobile with "prototype of undefined" (Tom, 2026-09-29).
export type AutoSave<T> = {
 readonly busy: boolean;
 enqueue(value: T, delay?: number): void;
 cancelPending(): void;
 flush(): Promise<void>;
};
export function createAutoSave<T>(save:(value:T)=>Promise<void>,changed:(status:string)=>void):AutoSave<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 let pending:{value:T}|undefined;
 let running=false;
 const flush=async()=>{
  if(timer){clearTimeout(timer);timer=undefined;}
  if(running)return;
  running=true;
  try{
   while(pending&&!timer){
    const {value}=pending;pending=undefined;changed('Saving…');
    try{await save(value);changed(pending?'Saving…':'Saved');}
    catch(error){changed(`Not saved: ${error instanceof Error?error.message:String(error)}. Change the field to retry.`);}
   }
  }finally{running=false;}
 };
 return {
  get busy(){return running||Boolean(pending)},
  enqueue(value,delay=0){
   pending={value};if(timer)clearTimeout(timer);
   changed('Unsaved changes');
   if(delay)timer=setTimeout(()=>{timer=undefined;void flush()},delay);
   else void flush();
  },
  cancelPending(){if(timer)clearTimeout(timer);timer=undefined;pending=undefined;},
  flush,
 };
}
