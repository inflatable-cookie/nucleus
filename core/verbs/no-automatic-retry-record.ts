import type { Task, TaskControlInput } from "../../shared/contracts";
import { noAutomaticRetryRule } from "../../shared/automatic-retry";
import type { Engine } from "../engine";

/** The controls whose instruction text an owner writes, so their retry rule is theirs to set. */
const RETRY_RULE_ACTIONS = new Set(["move", "restart", "route", "amend_brief"]);

/**
 * Task 645: an owner `move`, `restart`, `route` or `amend_brief` carries the
 * durable no-automatic-retry rule. The structured field wins; otherwise the
 * instruction, reason and brief text are read for the same phrases the
 * automatic gates read — the owner's own free text is the one place a phrase is
 * the decision. The rule survives the run it launches because the launch clears
 * the pending instruction, never this flag; only a later owner control that
 * permits retry (or structured false) lifts it. The control's own event is the
 * provenance.
 */
export function recordNoAutomaticRetryRule(engine: Engine, input: TaskControlInput, result: Task): Task {
  if (!RETRY_RULE_ACTIONS.has(input.action)) return result;
  const structured = input.noAutomaticRetry;
  const text = [input.instruction, input.reason, input.brief].filter((value): value is string => Boolean(value)).join('\n');
  const read = structured === true ? 'forbid' : structured === false ? 'lift' : noAutomaticRetryRule(text);
  if (!read) return result;
  const current = engine.store.task(result.id);
  const want = read === 'forbid';
  // Skip only a redundant record: a lift on a legacy row whose flag merely
  // defaults to false must still persist the decision, or the old-run fallback
  // keeps forbidding retry after the owner permitted it.
  if (current.resolution.noAutomaticRetry === want && current.resolution.noAutomaticRetryDecided)
    return current.version === result.version ? result : current;
  const control = input.action === 'move' && input.to ? `move to=${input.to}`
    : input.action === 'restart' ? `restart${input.role ? ` role=${input.role}` : ''}${input.fresh ? ' fresh' : ''}`
    : input.action === 'route' ? `route${input.role ? ` role=${input.role}` : ''}` : 'amend_brief';
  const controlEvent = engine.store.events(result.id).find(event => event.kind === 'owner_control')?.id ?? null;
  const provenance = `${control} at version ${result.version}${controlEvent ? ` (owner_control event ${controlEvent})` : ' (operator control)'}: ${(input.reason ?? input.instruction ?? '').slice(0, 500)}`;
  // Both directions are explicit owner decisions: the lift marker keeps the
  // old-run fallback from re-forbidding retry after the owner permitted it.
  return engine.store.update(current.id, { resolution: { ...current.resolution,
    noAutomaticRetry: want, noAutomaticRetryDecided: true, noAutomaticRetryProvenance: provenance } },
    want ? 'no_automatic_retry_recorded' : 'no_automatic_retry_lifted', provenance.slice(0, 2000));
}
