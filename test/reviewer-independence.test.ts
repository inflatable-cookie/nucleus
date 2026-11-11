import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewerIndependence, type ReviewerIndependence, type ReviewerIndependenceFacts } from '../core/dispatch/routing';

const s = (...keys: string[]) => new Set(keys);

test('reviewerIndependence outcomes by site', () => {
  const known = s('gpt');
  const empty = s();
  const opaque = s('default');
  const cases: [string, ReviewerIndependenceFacts, ReviewerIndependence][] = [
    ['proof-only empty authors: select is independent', { site: 'select', entrypoint: 'proof', authors: empty, currentAuthorModels: empty }, 'independent'],
    ['proof-only empty authors: assert is unknown (select/assert differ)', { site: 'assert', authors: empty, currentAuthorModels: empty, reviewerModel: 'muse', namedRequired: false, ownerRouted: false }, 'unknown'],
    ['proof-only empty authors: verify is unknown (same as assert)', { site: 'verify', authors: empty, currentAuthorModels: empty, reviewerModel: 'muse', namedRequired: false, ownerRouted: false }, 'unknown'],
    ['ordinary empty authors: select is unknown', { site: 'select', entrypoint: 'review', authors: empty, currentAuthorModels: known }, 'unknown'],
    ['select: unknown current author', { site: 'select', entrypoint: undefined, authors: known, currentAuthorModels: empty }, 'unknown'],
    ['select: opaque current author', { site: 'select', entrypoint: undefined, authors: known, currentAuthorModels: opaque }, 'unknown'],
    ['select: opaque authors', { site: 'select', entrypoint: undefined, authors: opaque, currentAuthorModels: known }, 'unknown'],
    ['select: known current and known authors', { site: 'select', entrypoint: undefined, authors: known, currentAuthorModels: known }, 'independent'],
    ['consult-bound default reviewer is independent when authors are known (site pin)', { site: 'consult', authors: known, reviewerModel: 'default' }, 'independent'],
    ['consult-bound default authors are unknown', { site: 'consult', authors: opaque, reviewerModel: 'muse' }, 'unknown'],
    ['consult-bound empty authors are unknown', { site: 'consult', authors: empty, reviewerModel: 'muse' }, 'unknown'],
    ['consult-bound collision has no owner-route waiver', { site: 'consult', authors: known, reviewerModel: 'gpt' }, 'collision'],
    ['consult-bound independent reviewer', { site: 'consult', authors: known, reviewerModel: 'muse' }, 'independent'],
    ['profile: default reviewer is unknown', { site: 'profile', authors: known, currentAuthorModels: known, reviewerModel: 'default', namedRequired: false, ownerRouted: false }, 'unknown'],
    ['profile: non-colliding reviewer', { site: 'profile', authors: known, currentAuthorModels: known, reviewerModel: 'muse', namedRequired: false, ownerRouted: false }, 'independent'],
    ['profile: collision without a named required request', { site: 'profile', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: false, ownerRouted: false }, 'collision'],
    ['profile: named required, current known, current does not have the model', { site: 'profile', authors: s('gpt', 'luna'), currentAuthorModels: known, reviewerModel: 'luna', namedRequired: true, ownerRouted: false }, 'waived'],
    ['profile: named required, current has the model, owner-routed', { site: 'profile', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: true, ownerRouted: true }, 'waived'],
    ['profile: named required, current has the model, not owner-routed', { site: 'profile', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: true, ownerRouted: false }, 'collision'],
    ['profile: named required, current unknown, no waiver (select vs assert differ)', { site: 'profile', authors: known, currentAuthorModels: empty, reviewerModel: 'gpt', namedRequired: true, ownerRouted: true }, 'collision'],
    ['assert: empty authors unknown', { site: 'assert', authors: empty, currentAuthorModels: known, reviewerModel: 'muse', namedRequired: false, ownerRouted: false }, 'unknown'],
    ['assert: opaque authors unknown', { site: 'assert', authors: opaque, currentAuthorModels: known, reviewerModel: 'muse', namedRequired: false, ownerRouted: false }, 'unknown'],
    ['assert: default reviewer unknown', { site: 'assert', authors: known, currentAuthorModels: known, reviewerModel: 'default', namedRequired: false, ownerRouted: false }, 'unknown'],
    ['assert: opaque current author unknown', { site: 'assert', authors: known, currentAuthorModels: opaque, reviewerModel: 'muse', namedRequired: false, ownerRouted: false }, 'unknown'],
    ['assert: non-colliding reviewer', { site: 'assert', authors: known, currentAuthorModels: known, reviewerModel: 'muse', namedRequired: false, ownerRouted: false }, 'independent'],
    ['assert: collision without named request', { site: 'assert', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: false, ownerRouted: false }, 'collision'],
    ['assert: named required, current does not have the model (no currentKnown gate)', { site: 'assert', authors: s('gpt', 'luna'), currentAuthorModels: known, reviewerModel: 'luna', namedRequired: true, ownerRouted: false }, 'waived'],
    ['assert: named required, current has the model, owner-routed', { site: 'assert', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: true, ownerRouted: true }, 'waived'],
    ['assert: named required, current has the model, not owner-routed', { site: 'assert', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: true, ownerRouted: false }, 'collision'],
    ['verify: collision without named request', { site: 'verify', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: false, ownerRouted: false }, 'collision'],
    ['verify: owner-routed current-author waiver', { site: 'verify', authors: known, currentAuthorModels: known, reviewerModel: 'gpt', namedRequired: true, ownerRouted: true }, 'waived'],
  ];
  for (const [label, facts, expected] of cases) assert.equal(reviewerIndependence(facts), expected, label);
});
