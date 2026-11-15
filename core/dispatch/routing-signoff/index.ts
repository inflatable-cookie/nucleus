/**
 * The routing sign-off owner: the record a request's board answer lives in, the
 * planner grants that stand in for a per-task answer, and the per-task pass that
 * applies both. One import path serves the board, the route verbs, the task
 * sweep and the question runtime, so no caller picks a half of the mechanism.
 */
export {
  ROLES, OPERATOR_BOARD, SIGNOFF_DECLINE, signoffApprove, signoffUse, boardSignoff, grantSignoff,
  alternatives, outcome, withdrawOpen, withGrantSignoff, withEndedGrant, withoutGrantSignoff,
  readSignoffEvents, priorNonGrantSignoff, priorApprovedSignoff, signoffQuestion,
  type Role, type Request, type Signoff, type SignoffEvent, type ApprovedRoute,
} from "./request";
export {
  GRANT_OPERATOR_BOARD, GRANT_APPROVE, GRANT_DECLINE, readRoutingGrants, grantArchiveDue, activeRoutingGrants,
  coveringGrant, reconcileRoutingGrants, reconcileGrantDecisions, archiveRoutingGrants, applyRoutingGrant,
} from "./grants";
export { reconcileRoutingSignoffs } from "./reconcile";
