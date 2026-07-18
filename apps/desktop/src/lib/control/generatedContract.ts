// Compile-time drift guard between the hand-written control envelope types
// and the ts-rs bindings generated from the Rust DTOs.
//
// Direction: every hand-written variant must remain assignable to the
// generated contract. A renamed or retyped field on the Rust side breaks
// this file at `svelte-check` time instead of surfacing as `undefined` in a
// panel. (The generated union is wider than the hand-written one — variants
// the client does not consume yet are legal.)
//
// Regenerate with:
//   TS_RS_EXPORT_DIR=$PWD/apps/desktop/src/lib/control/generated \
//     cargo test -p nucleus-server export_bindings

import type { ControlResponseEnvelopeDto as GeneratedResponse } from "./generated/ControlResponseEnvelopeDto";
import type { ControlRequestEnvelopeDto as GeneratedRequest } from "./generated/ControlRequestEnvelopeDto";
import type {
  ControlRequestEnvelopeDto as HandRequest,
  ControlResponseEnvelopeDto as HandResponse,
} from "./envelopes";

type AssertAssignable<A extends B, B> = A;

export type HandResponseMatchesGenerated = AssertAssignable<HandResponse, GeneratedResponse>;
export type HandRequestMatchesGenerated = AssertAssignable<HandRequest, GeneratedRequest>;
