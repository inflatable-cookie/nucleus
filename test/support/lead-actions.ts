import { leadActionsSchema, type LeadDetail } from "../../shared/contracts";

type ActionHints = LeadDetail["actions"];

/** Action hints returned by the lead detail fixture. A case supplies its own refusals. */
export function leadActionHints(
  repositories: readonly { origin: string }[],
  overrides: Partial<ActionHints> = {},
): ActionHints {
  return leadActionsSchema.parse({
    check: null,
    approve: "Check the brief first",
    drop: null,
    reopen: "Only a dropped lead can be reopened",
    park: null,
    unpark: "This lead is not parked",
    promoteTo: null,
    promote: repositories.map(({ origin }) => ({
      origin,
      reason: "Approve the checked version first",
    })),
    ...overrides,
  });
}
