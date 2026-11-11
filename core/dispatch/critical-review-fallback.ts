import { type Profile, type Task } from '../../shared/contracts';
import { now } from '../store/store';
import { criticalReviewerMeets } from './routing';
import { honouredRequest } from '../../shared/pool';
import type { Resolution } from '../resolution';

export type CriticalReviewFallbackContext = Pick<Resolution, 'store' | 'update'>;

export class CriticalReviewFallback {
  constructor(readonly context: CriticalReviewFallbackContext) {}
  recordCriticalReviewFallback(t: Task, profile: Profile): Task {
    if (!t.critical || honouredRequest(t.profileRequests?.reviewer, this.context.store.pool(), this.context.store.usageLevel())?.profileId === profile.id
      || criticalReviewerMeets(t, profile, this.context.store.pool())) return t;
    const record = { at: now(), workerProfileId: t.profile?.id ?? null, reviewerProfileId: profile.id,
      reason: 'No available independent reviewer with a known capability at least as high as the worker; ordinary reviewer selection used' };
    return this.context.update(t, { criticalReviewFallbacks: [...t.resolution.criticalReviewFallbacks, record] }, {}, 'critical_review_fallback', JSON.stringify(record));
  }
}
