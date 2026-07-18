// Shared fallback states and single-record response parsing for the
// per-query control modules. One implementation of the
// empty/unsupported/error/unexpected ladder instead of a copy per query.

import type { ControlResponseEnvelopeDto } from "./envelopes";

export type QueryFallback =
  | { state: "empty" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; kind: string; reason: string }
  | { state: "unexpected"; reason: string };

type ResponseBody = ControlResponseEnvelopeDto["body"];

export function parseSingleRecordResponse<CaseType extends ResponseBody["type"], Out>(
  response: ControlResponseEnvelopeDto,
  caseType: CaseType,
  label: string,
  extract: (body: Extract<ResponseBody, { type: CaseType }>) => Out,
): Out | QueryFallback {
  const body = response.body;
  if (body.type === caseType) {
    return extract(body as Extract<ResponseBody, { type: CaseType }>);
  }
  switch (body.type) {
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return { state: "unsupported", reason: body.reason };
    case "error":
      return { state: "error", kind: body.kind, reason: body.reason };
    default:
      return {
        state: "unexpected",
        reason: `unexpected ${label} response: ${body.type}`,
      };
  }
}
