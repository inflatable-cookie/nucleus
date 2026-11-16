import {request} from 'node:http';

/**
 * Shared callback transport for MCP, the CLI and the standalone reporting
 * helper. Self-contained on purpose: the service writes these exact bytes into
 * the helper it hands an agent (plus its report program), so a helper must never
 * need to resolve another module from the data home. The transport *facts* a
 * failure carries stay owned by `transport.mjs`.
 */

/** Read this launch's callback environment: `NUCLEUS_*` only, never a retained old name. */
export function callbackEnvValue(name, env = process.env) {
 return env[`NUCLEUS_${name}`];
}

/** Shared callback transport. Never retries. */
export function callbackRequest(binding, path, payload, {timeoutMs = 120000, timeoutMessage = 'Queue request timed out; inspect current state before retrying'} = {}) {
 const body = JSON.stringify(payload);
 return new Promise((resolve, reject) => {
  const phase = (name) => (error) => {
   try { error.transportPhase = name; } catch { /* a non-object rejection stays untagged */ }
   reject(error);
  };
  const req = request({socketPath: binding.socketPath, path, method: 'POST', headers: {
   authorization: 'Bearer ' + binding.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  }}, res => {
   let response = '';
   res.on('error', phase('response'));
   res.on('data', chunk => { response += chunk; });
   res.on('end', () => {
    if (res.statusCode !== 200) { const failure = new Error(response); failure.callbackStatus = res.statusCode; reject(failure); return; }
    try { resolve(JSON.parse(response)); } catch { reject(new Error('Invalid Queue response; inspect current state before retrying')); }
   });
  });
  req.setTimeout(timeoutMs, () => req.destroy(new Error(timeoutMessage)));
  req.on('error', phase('request'));
  req.end(body);
 });
}
