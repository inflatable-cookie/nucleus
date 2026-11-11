import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isQuotaExhaustion,isRateLimitError,isTransientProviderError,rateLimitCooldownData,rateLimitGroupCooldownAt,transientProviderRetryAt} from '../core/recovery/exhaustion';
test('quota classification requires explicit exhaustion, not generic throttling or task text',()=>{
 for(const message of ['insufficient_quota','usage_limit_reached','Weekly usage limit exceeded','You have reached your weekly usage limit','Monthly quota exhausted','API error (status 402 Payment Required): Grok Build usage balance exhausted','opencode-go API error (429): {"type":"server_error","message":"Upstream request failed: Account budget exceeded"}','Upgrade your plan to continue'])assert.equal(isQuotaExhaustion(message),true,message);
 for(const message of ['HTTP 429 Too Many Requests','ECONNRESET','Model unavailable','rate limit exceeded','Tests failed','context window exceeded','Time budget exceeded','error budget exceeded','Token budget exceeded for this turn'])assert.equal(isQuotaExhaustion(message),false,message);
});

import {providerRetryAt} from '../core/recovery/exhaustion';
test('reset timing accepts explicit zoned times and bounded provider seconds, never ambiguous dates',()=>{
 const now=Date.parse('2026-09-07T12:00:00Z');
 assert.equal(providerRetryAt('', '2026-09-07T15:00:00+01:00',now),'2026-09-07T14:00:00.000Z');
 assert.equal(providerRetryAt('{"error":{"retry_after_seconds":3600}}',undefined,now),'2026-09-07T13:00:00.000Z');
 assert.equal(providerRetryAt('Usage limit reached; resets at 2026-09-08T12:00:00Z',undefined,now),'2026-09-08T12:00:00.000Z');
 for(const s of ['resets Friday','resets at 5pm','resets at 2026-09-08T12:00:00','{"reset_at":"2026-09-06T12:00:00Z"}','{"retry_after_seconds":-1}'])assert.equal(providerRetryAt(s,undefined,now),null,s);
});

test('transient provider errors stay distinct from quota exhaustion and use provider timing or bounded backoff',()=>{
 const at=Date.parse('2026-10-02T12:00:00Z');
 for(const message of [
  'opencode-go API error (429): rate_limit_error; retry after a brief wait',
  '429: {"code":"1302","message":"Rate limit reached for requests"}',
  'HTTP 429 Too Many Requests',
  'HTTP 429 Too Many Requests; retry-after: 30',
  'API error (status 503 Service Unavailable)',
  'API error (status 502 Bad Gateway)',
  'API error (status 529 Overloaded)',
  'Invalid settings file ~/.pi/agent/settings.json: Lock file is already being held\nUnknown option: --mcp-config',
 ])assert.equal(isTransientProviderError(message),true,message);
 for(const message of ['429 usage_limit_reached','HTTP 402 usage balance exhausted','ECONNRESET'])assert.equal(isTransientProviderError(message),false,message);
 // Task 646: the same-thread backoff spreads resumes as 1m/2m/4m/8m.
 assert.equal(transientProviderRetryAt('rate_limit_error',0,at),'2026-10-02T12:01:00.000Z');
 assert.equal(transientProviderRetryAt('rate_limit_error',1,at),'2026-10-02T12:02:00.000Z');
 assert.equal(transientProviderRetryAt('rate_limit_error',2,at),'2026-10-02T12:04:00.000Z');
 assert.equal(transientProviderRetryAt('rate_limit_error',3,at),'2026-10-02T12:08:00.000Z');
 assert.equal(transientProviderRetryAt('HTTP 429; retry-after: 45',0,at),'2026-10-02T12:00:45.000Z');
 assert.equal(transientProviderRetryAt('{"error":{"retry_after_seconds":12}}',0,at),'2026-10-02T12:00:12.000Z');
});

test('rate-limit pacing honors provider timing, else a short group cool-down',()=>{
 const at=Date.parse('2026-10-02T12:00:00Z');
 assert.equal(isRateLimitError('429: {"code":"1302","message":"Rate limit reached for requests"}'),true);
 assert.equal(isRateLimitError('HTTP 429 Too Many Requests'),true);
 assert.equal(isRateLimitError('rate limit exceeded'),true);
 assert.equal(isRateLimitError('429 usage_limit_reached'),false);
 assert.equal(isRateLimitError('API error (status 503 Service Unavailable)'),false);
 assert.equal(rateLimitGroupCooldownAt('HTTP 429; retry-after: 45',at),'2026-10-02T12:00:45.000Z');
 assert.equal(rateLimitGroupCooldownAt('429: {"code":"1302","message":"Rate limit reached"}',at),'2026-10-02T12:05:00.000Z');
});

test('a later 429 without Retry-After never shortens a recorded provider deadline',()=>{
 const at=Date.parse('2026-10-02T12:00:00Z');
 const withRetry = JSON.stringify({group:'zai',unavailable:true,reason:'Rate limit',retryAt:'2026-10-02T12:30:00.000Z'});
 const kept = JSON.parse(rateLimitCooldownData(withRetry,'429: {"code":"1302"}','zai',at));
 assert.equal(kept.retryAt,'2026-10-02T12:30:00.000Z','the longer provider deadline survives a bare 429');
 assert.equal(kept.unavailable,true);
 const sooner = JSON.stringify({group:'zai',unavailable:true,reason:'Rate limit',retryAt:'2026-10-02T12:01:00.000Z'});
 const moved = JSON.parse(rateLimitCooldownData(sooner,'HTTP 429; retry-after: 300','zai',at));
 assert.equal(moved.retryAt,'2026-10-02T12:05:00.000Z','a later provider retry time still extends the cool-down');
 const broken = JSON.parse(rateLimitCooldownData('not-json','429','zai',at));
 assert.equal(broken.retryAt,'2026-10-02T12:05:00.000Z','an unreadable row carries no deadline');
 const past = JSON.stringify({group:'zai',unavailable:true,reason:'Rate limit',retryAt:'2026-10-02T11:00:00.000Z'});
 const fresh = JSON.parse(rateLimitCooldownData(past,'429','zai',at));
 assert.equal(fresh.retryAt,'2026-10-02T12:05:00.000Z','an expired deadline does not pin the cool-down');
});
