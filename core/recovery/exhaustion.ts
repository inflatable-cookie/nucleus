import { steppedDelay } from "../../shared/backoff";
// Transport errors and generic HTTP 429s do not establish subscription exhaustion.
export function isPiSettingsLockFailure(error: string) {
  return /\bInvalid settings file\b[^\r\n]{0,500}\.pi[\\/][^\r\n]*settings\.json[^\r\n]*\bLock file is already being held\b/i.test(error);
}

/**
 * Cursor answers a plan-limited review turn with this exact sentence and no
 * callback. It is a terminal provider refusal, never a throttle, so it
 * participates in the same exhaustion classification as quota/balance text.
 */
export function isCursorPlanRefusal(error: string) {
  return /\bupgrade your plan to continue\b/i.test(error);
}

export function isQuotaExhaustion(error: string) {
  return isCursorPlanRefusal(error)
    || /\b(insufficient_quota|usage_limit_reached|quota_exceeded)\b/i.test(error)
    || /\b(?:usage|account|billing)?\s*balance\b.{0,50}\b(?:exhausted|depleted|insufficient)\b/i.test(error)
    || /\b(?:exhausted|depleted|insufficient)\b.{0,50}\b(?:usage|account|billing)?\s*balance\b/i.test(error)
    || /\b(?:weekly|monthly|daily|subscription|usage|credit|spending) (?:usage )?(?:limit|quota|credits?)\b.{0,70}\b(?:reached|exceeded|exhausted|depleted)\b/i.test(error)
    || /\b(?:reached|exceeded|exhausted)\b.{0,50}\b(?:weekly|monthly|daily|subscription|usage|credit|spending) (?:usage )?(?:limit|quota)\b/i.test(error)
    || /\b(?:account|billing|spending|credit|usage) budget\b.{0,30}\b(?:exceeded|exhausted|depleted|reached)\b/i.test(error);
}

/** A stopped provider turn that is expected to recover without changing profiles.
 *
 * Task 646: every 429 that is not quota exhaustion backs off in place, even
 * without an explicit rate-limit phrase. Provider 429 payloads vary (for
 * example GLM's `{"code":1302,"message":"Rate limit reached"}`), and
 * treating a bare 429 as unknown parked a burst of rate-limited agents in
 * `needs_attention` instead of pacing them.
 */
export function isTransientProviderError(error: string) {
  if (!error || isQuotaExhaustion(error)) return false;
  if (isPiSettingsLockFailure(error)) return true;
  if (/\b429\b/.test(error)) return true;
  return /\b(?:502|503|529)\b/.test(error);
}

/** A 429 / rate-limit error that paces its provider group, never quota exhaustion. */
export function isRateLimitError(error: string) {
  if (!error || isQuotaExhaustion(error)) return false;
  return /\b429\b/.test(error) || /\brate[_ -]?limit|too many requests|\b1302\b/i.test(error);
}

export const TRANSIENT_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000] as const;
/** Same-thread resumes before a rate-limit failover routes to another profile. */
export const TRANSIENT_MAX_RESUMES = TRANSIENT_BACKOFF_MS.length;
/** Short per-group launch pacing applied when a group returns rate limits. */
export const RATE_LIMIT_GROUP_COOLDOWN_MS = 5 * 60_000;
const MAX_PROVIDER_RETRY_AFTER_MS = 31 * 24 * 60 * 60 * 1000;

function retryAfterDeadline(value: unknown, at: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0 || seconds * 1000 > MAX_PROVIDER_RETRY_AFTER_MS) return null;
    return new Date(at + seconds * 1000).toISOString();
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time) || time <= at || time - at > MAX_PROVIDER_RETRY_AFTER_MS) return null;
  return new Date(time).toISOString();
}

/** Honor an explicit provider Retry-After; otherwise use the bounded 1m/2m/4m/8m sequence. */
export function providerGivenRetryAt(error: string, at = Date.now()): string | null {
  try {
    const data = JSON.parse(error);
    for (const object of [data, data?.error, data?.details]) {
      if (!object || typeof object !== 'object') continue;
      const value = object.retry_after ?? object.retryAfter ?? object.retry_after_seconds ?? object.retryAfterSeconds;
      const deadline = retryAfterDeadline(value, at);
      if (deadline) return deadline;
    }
  } catch { /* Provider errors are often plain text. */ }
  const header = error.match(/\bretry[-_ ]after\s*[:=]\s*([^\r\n;]+)/i)?.[1]?.trim();
  const headerDeadline = retryAfterDeadline(header, at);
  if (headerDeadline) return headerDeadline;
  const phrase = error.match(/\bretry\s+after\s+(?:about\s+|approximately\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)/i);
  if (phrase) {
    const amount = Number(phrase[1]);
    const multiplier = /^(?:m|minutes?)/i.test(phrase[2]) ? 60_000 : 1_000;
    const deadline = retryAfterDeadline(amount * multiplier / 1000, at);
    if (deadline) return deadline;
  }
  return null;
}

export function transientProviderRetryAt(error: string, resumes: number, at = Date.now()): string {
  return providerGivenRetryAt(error, at) ?? new Date(at + steppedDelay(TRANSIENT_BACKOFF_MS, resumes)).toISOString();
}

/** Per-group launch pacing for a rate-limited group: the provider's own retry
 * time when given, otherwise a short five-minute cool-down recorded in
 * capacity state so new launches prefer other eligible profiles meanwhile. */
export function rateLimitGroupCooldownAt(error: string, at = Date.now()): string {
  return providerGivenRetryAt(error, at) ?? new Date(at + RATE_LIMIT_GROUP_COOLDOWN_MS).toISOString();
}

/** Merge a new rate-limit cool-down with any recorded one, keeping the later
 * deadline: a 429 without Retry-After must never shorten a provider deadline
 * recorded earlier. Returns the serialized availability row data. */
export function rateLimitCooldownData(existingData: unknown, error: string, group: string, at = Date.now()): string {
  let prevRetryAt: string | null = null;
  try {
    const parsed = typeof existingData === 'string' ? JSON.parse(existingData) : existingData;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { retryAt?: unknown }).retryAt === 'string'
      && Number.isFinite(Date.parse((parsed as { retryAt: string }).retryAt)) && Date.parse((parsed as { retryAt: string }).retryAt) > at)
      prevRetryAt = (parsed as { retryAt: string }).retryAt;
  } catch { /* an unreadable row carries no deadline */ }
  const next = rateLimitGroupCooldownAt(error, at);
  const retryAt = prevRetryAt && Date.parse(prevRetryAt) > Date.parse(next) ? prevRetryAt : next;
  const reason = `Rate limit on subscription group ${group}; pacing new launches until ${retryAt}. Evidence: ${error.slice(0, 400)}`;
  return JSON.stringify({ group, unavailable: true, reason: reason.slice(0, 2000), retryAt });
}

// Parse explicit provider timing only. Never guess a timezone or a weekly reset day.
export function providerRetryAt(error: string, explicit?: string, at = Date.now()): string | null {
  const valid = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
    const time=Date.parse(value);return Number.isFinite(time)&&time>at?new Date(time).toISOString():null;
  };
  if (explicit) return valid(explicit);
  try {
    const data=JSON.parse(error);
    for(const object of [data,data.error,data.details]) {
      if(!object||typeof object!=='object')continue;
      for(const key of ['reset_at','resetAt','retry_at','retryAt']) {const result=valid(object[key]);if(result)return result;}
      const seconds=object.retry_after_seconds ?? object.retryAfterSeconds;
      if(typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>0&&seconds<=31*86400)return new Date(at+seconds*1000).toISOString();
    }
  } catch { /* Provider may expose a plain-text error. */ }
  const timestamp=error.match(/\b(?:resets?(?: at| on)?|retry at)\s*[:=]?\s*(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))/i)?.[1];
  return valid(timestamp);
}
