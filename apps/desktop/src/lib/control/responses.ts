import type {
  ControlCommandEvidenceRecordDto,
  ControlDiagnosticsResultDto,
  ControlProviderReadIntentQueryResultDto,
  ControlProviderReadinessOverviewDto,
  ControlProjectRecordDto,
  ControlGoalRecordDto,
  ControlRuntimeReadinessDiagnosticDto,
  TaskAgentWorkUnitDiagnosticDto,
  ControlTaskRecordDto,
} from "./types";
import type { ControlResponseEnvelopeDto } from "./envelopes";

export type CommandHistoryQueryResult =
  | {
      state: "records";
      records: ControlCommandEvidenceRecordDto[];
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export type RuntimeReadinessQueryResult =
  | {
      state: "records";
      records: ControlRuntimeReadinessDiagnosticDto[];
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export type TaskWorkProgressQueryResult =
  | {
      state: "records";
      records: TaskAgentWorkUnitDiagnosticDto[];
      client_can_mutate: boolean;
      provider_execution_available: boolean;
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export type DiagnosticsQueryResult =
  | {
      state: "records";
      result: ControlDiagnosticsResultDto;
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export type ProviderReadinessOverviewQueryResult =
  | {
      state: "record";
      overview: ControlProviderReadinessOverviewDto;
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export type ProviderReadIntentQueryResult =
  | {
      state: "record";
      result: ControlProviderReadIntentQueryResultDto;
    }
  | {
      state: "empty";
    }
  | {
      state: "unsupported";
      reason: string;
    }
  | {
      state: "error";
      kind: string;
      reason: string;
    }
  | {
      state: "unexpected";
      reason: string;
    };

export function projectRecordsFromResponse(
  response: ControlResponseEnvelopeDto,
): ControlProjectRecordDto[] {
  return response.body.type === "project_records" ? response.body.records : [];
}

export function taskRecordsFromResponse(
  response: ControlResponseEnvelopeDto,
): ControlTaskRecordDto[] {
  return response.body.type === "task_records" ? response.body.records : [];
}

export function goalRecordsFromResponse(
  response: ControlResponseEnvelopeDto,
): ControlGoalRecordDto[] {
  return response.body.type === "goal_records" ? response.body.records : [];
}

export function commandHistoryFromResponse(
  response: ControlResponseEnvelopeDto,
): CommandHistoryQueryResult {
  switch (response.body.type) {
    case "command_evidence_records":
      return {
        state: "records",
        records: response.body.records,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected command history response: ${response.body.type}`,
      };
  }
}

export function runtimeReadinessFromResponse(
  response: ControlResponseEnvelopeDto,
): RuntimeReadinessQueryResult {
  switch (response.body.type) {
    case "runtime_readiness_diagnostics":
      return {
        state: "records",
        records: response.body.records,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected runtime readiness response: ${response.body.type}`,
      };
  }
}

export function taskWorkProgressFromResponse(
  response: ControlResponseEnvelopeDto,
): TaskWorkProgressQueryResult {
  switch (response.body.type) {
    case "task_work_progress_records":
      return {
        state: "records",
        records: response.body.records,
        client_can_mutate: response.body.client_can_mutate,
        provider_execution_available: response.body.provider_execution_available,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected task work progress response: ${response.body.type}`,
      };
  }
}

export function diagnosticsFromResponse(response: ControlResponseEnvelopeDto): DiagnosticsQueryResult {
  switch (response.body.type) {
    case "diagnostics":
      return {
        state: "records",
        result: response.body.result,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected diagnostics response: ${response.body.type}`,
      };
  }
}

export function providerReadinessOverviewFromResponse(
  response: ControlResponseEnvelopeDto,
): ProviderReadinessOverviewQueryResult {
  switch (response.body.type) {
    case "provider_readiness_overview":
      return {
        state: "record",
        overview: response.body.overview,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected provider readiness overview response: ${response.body.type}`,
      };
  }
}

export function providerReadIntentFromResponse(
  response: ControlResponseEnvelopeDto,
): ProviderReadIntentQueryResult {
  switch (response.body.type) {
    case "provider_read_intent":
      return {
        state: "record",
        result: response.body.result,
      };
    case "query_empty":
      return { state: "empty" };
    case "query_unsupported":
      return {
        state: "unsupported",
        reason: response.body.reason,
      };
    case "error":
      return {
        state: "error",
        kind: response.body.kind,
        reason: response.body.reason,
      };
    default:
      return {
        state: "unexpected",
        reason: `unexpected provider read-intent response: ${response.body.type}`,
      };
  }
}
