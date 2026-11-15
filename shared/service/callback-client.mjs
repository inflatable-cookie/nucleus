import {request} from 'node:http';
import {callbackTransportPhase} from './transport.mjs';

/** Read this launch's callback environment: `NUCLEUS_*` only, never a retained old name. */
export function callbackEnvValue(name, env = process.env) {
 return env[`NUCLEUS_${name}`];
}

/**
 * Which transport phase a callback failure happened in, or null when the
 * failure is not the transport at all (a Queue answer, a Queue refusal, a
 * timeout budget). Task 562: the phases carry different delivery truths, and a
 * binding must never state one it cannot know.
 *
 * - `connect`: the request never reached Queue — a definite not-recorded retry.
 * - `inflight`: the call was lost in flight after or while being delivered, so
 *   Queue may already hold the question and only the call was lost.
 * - `response`: Queue processed the ask (a 200 response had started) and only
 *   the response was lost — the recorded receipt is collectable by an
 *   identical re-ask.
 */
export {callbackTransportPhase};

/** Shared callback transport for MCP and the standalone reporting helper. Never retries. */
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
