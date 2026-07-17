import { describe, expect, test } from "bun:test";
import type { ControlResponseEnvelopeDto } from "./envelopes";
import {
  commandHistoryFromResponse,
  goalRecordsFromResponse,
  projectRecordsFromResponse,
  taskRecordsFromResponse,
} from "./responses";

function envelope(body: ControlResponseEnvelopeDto["body"]): ControlResponseEnvelopeDto {
  return {
    protocol_family: "nucleus.control",
    protocol_version: 1,
    request_id: "request:test",
    status: "complete",
    body,
  };
}

describe("control response parsing", () => {
  test("record helpers return records for their own body type only", () => {
    const projects = envelope({
      type: "project_records",
      records: [],
    });

    expect(projectRecordsFromResponse(projects)).toEqual([]);
    expect(taskRecordsFromResponse(projects)).toEqual([]);
    expect(goalRecordsFromResponse(projects)).toEqual([]);
  });

  test("command history maps empty, unsupported, and error bodies to states", () => {
    expect(commandHistoryFromResponse(envelope({ type: "query_empty" }))).toEqual({
      state: "empty",
    });
    expect(
      commandHistoryFromResponse(envelope({ type: "query_unsupported", reason: "nope" })),
    ).toEqual({ state: "unsupported", reason: "nope" });
    expect(
      commandHistoryFromResponse(
        envelope({ type: "error", kind: "storage", reason: "db locked" } as never),
      ),
    ).toEqual({ state: "error", kind: "storage", reason: "db locked" });
  });

  test("a body type this client does not know yields an explicit unexpected state", () => {
    const drifted = envelope({ type: "future_variant" } as never);
    const result = commandHistoryFromResponse(drifted);

    expect(result.state).toBe("unexpected");
  });
});
