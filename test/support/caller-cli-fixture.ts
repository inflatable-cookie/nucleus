import { spawn } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameReader, encodeFrame, PROTOCOL_VERSION } from '../../shared/service/protocol';
import { Store } from '../../core/store/store';
import { submissionSchema } from '../../shared/contracts';
import { deriveTaskTelemetry } from '../../core/telemetry/telemetry';
import { formatAgentId } from '../../shared/agent-identity';

// The CLI installs tsx dynamically. Its refinements' Function.toString() differs
// from the test runner's preloaded CJS transforms, which are part of wire hashes.
let contracts: Promise<Record<string, string>> | undefined;
function cliContractDigests() {
  return contracts ??= new Promise<Record<string, string>>((resolve, reject) => {
    const script = `await import('tsx'); const {rpcContractDigests} = await import(${JSON.stringify(new URL('../../shared/rpc-contracts.ts', import.meta.url).href)}); process.stdout.write(JSON.stringify(rpcContractDigests()));`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { env: process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`CLI contract fixture failed (${code}): ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

export async function callerCliFixture() {
  const rpcContracts = await cliContractDigests();
  const dir = mkdtempSync(join(tmpdir(), 'caller-cli-'));
  const store = new Store(':memory:');
  const task = store.insert(submissionSchema.parse({submissionId:'caller-fixture',title:'Synthetic task',repoPath:dir,planningCommit:'a'.repeat(40),handoffPath:'synthetic.md',originAgentId:'thread'}),'paseo-fixture','handoff','a'.repeat(40));
  const detail = {task,events:[],runs:[],notices:[],dependencies:[],hooks:[],telemetry:deriveTaskTelemetry(task,[],[],[],[])};
  const calls: Array<{method: string; input: any}> = [];
  const callbacks: Array<{path: string | undefined; input: any}> = [];
  const hostResolutions: unknown[] = [];
  let revoked = false;
  const callback = httpServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const input = JSON.parse(body);
      callbacks.push({path: req.url, input});
      if (req.headers.authorization !== 'Bearer synthetic-secret' || revoked) {res.writeHead(403);res.end('Planner participant ticket is revoked or invalid');return;}
      res.end(JSON.stringify(req.url === '/caller' ? {caller: formatAgentId('t3code:fixture', 'thread'),hostId:'t3code:fixture',source:input.participantId ? 'participant-ticket' : 'run-ticket'} : {ok:true}));
    });
  });
  const callbackPath = join(dir,'c');
  await new Promise<void>(resolve => callback.listen(callbackPath, resolve));
  const server = socketServer(socket => {
    const reader = createFrameReader((frame: any) => {
      let result: unknown = {};
      if (frame.method === 'service.health') result = {protocolVersion:PROTOCOL_VERSION,rpcContracts};
      else if (frame.method === 'caller.resolve') {hostResolutions.push(frame.input);result = {caller:formatAgentId('paseo-fixture',frame.input.nativeAgentId),hostId:'paseo-fixture',source:'host'};}
      else if (frame.method !== 'service.auth') {
        calls.push({method:frame.method,input:frame.input});
        if(frame.method === 'queue.detail') result = detail;
        else {socket.write(encodeFrame({v:PROTOCOL_VERSION,id:frame.id,error:{code:'fixture-received',message:'Synthetic caller payload received'}}));return;}
      }
      socket.write(encodeFrame({v:PROTOCOL_VERSION,id:frame.id,result}));
    }, error => {throw error;});
    socket.on('data', chunk => reader.feed(chunk));
  });
  const socketPath = join(dir,'s');
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  writeFileSync(join(dir,'queue-service.json'),JSON.stringify({protocolVersion:PROTOCOL_VERSION,buildId:'fixture-build',socketPath,credential:'a'.repeat(64),pid:process.pid,startedAt:new Date().toISOString()}));
  for (const [source,payload] of Object.entries({run:{taskId:'task',runId:'run'},participant:{participantId:'00000000-0000-4000-8000-000000000001'}}))
    writeFileSync(join(dir,source+'.json'),JSON.stringify({socketPath:callbackPath,token:'synthetic-secret',...payload}));
  return {
    calls, callbacks, hostResolutions, dir, revoke: () => {revoked=true;},
    caller: (source: string) => formatAgentId(source === 'host' ? 'paseo-fixture' : 't3code:fixture','thread'),
    invoke: (source: string, script: string, args: string[], input?: unknown, overrides: NodeJS.ProcessEnv = {}) => new Promise<{code:number|null;stdout:string;stderr:string}>(resolve => {
      const child=spawn(process.execPath,[new URL('../../bin/'+script,import.meta.url).pathname,...args],{env:{...process.env,NUCLEUS_DATA_HOME:dir,NUCLEUS_TICKET:['run','participant'].includes(source)?join(dir,source+'.json'):'',PASEO_AGENT_ID:source==='host'?'thread':'',...overrides}});
      let stdout='',stderr='';
      child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.on('error', error => resolve({code:null,stdout,stderr:stderr + String(error)}));
      child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input===undefined?'':JSON.stringify(input));
    }),
    close: async () => {store.close();callback.closeAllConnections();await Promise.all([new Promise<void>(resolve=>callback.close(()=>resolve())),new Promise<void>(resolve=>server.close(()=>resolve()))]);rmSync(dir,{recursive:true,force:true});},
  };
}
