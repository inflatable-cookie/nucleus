import { useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { BoardLiveContext } from "../board-live";
import { type Colors } from "../controls";
import { errorText } from "../error-text";
import * as api from "../../shared/contracts";
import { operationStateLabel } from "../../shared/operations";
import {
  LeadScreen,
  checkLabel,
  type LeadActions,
  type LeadRead,
} from "../lead-screen";
import { RecordModal } from "./record-modal";

/**
 * The lead detail dialog. The lead screen owns its forms and reports each action's result
 * beside its control; the board passes `leadAct`, which refreshes the board and this record.
 */
export function LeadDialog({
  id: selectedLeadId,
  project,
  lane: leadLane,
  compact,
  busy,
  leadAct,
  onClose,
  c,
  inline = false,
}: {
  inline?: boolean;
  id: string;
  project?: string;
  lane: { key: string; title: string } | null;
  compact: boolean;
  busy: boolean;
  leadAct: <T>(fn: () => Promise<T>) => Promise<T>;
  onClose: () => void;
  c: Colors;
}) {
  const live = useContext(BoardLiveContext);
  const scope = project ? { project } : {};
  const fetchLead = useRpc(api.leadGet),
    dropLead = useRpc(api.leadDrop),
    checkLead = useRpc(api.leadCheck),
    approveLead = useRpc(api.leadApprove);
  const reopenLead = useRpc(api.leadReopen),
    promoteLeadTo = useRpc(api.leadPromote),
    fetchLeadVersion = useRpc(api.leadVersion),
    promoteLead = useRpc(api.leadPromoteTask);
  const parkLead = useRpc(api.leadPark),
    unparkLead = useRpc(api.leadUnpark);
  const leadDetailQuery = useQuery({
    queryKey: ["nucleus", "lead", selectedLeadId, project],
    queryFn: () => fetchLead({ ...scope, id: selectedLeadId! }),
    enabled: Boolean(selectedLeadId),
    refetchInterval: live ? false : 4000,
  });
  const leadDetail = leadDetailQuery.data;
  /**
   * #868: every lead action reports its own result or refusal inside the lead screen, so each
   * handler resolves with what happened. The screen renders loading and failed reads itself, so
   * these exist only once the record has loaded.
   */
  const leadActions: LeadActions | null = leadDetail
    ? {
        onCheck: () =>
          leadAct(async () =>
            checkLabel(
              (
                await checkLead({
                  id: leadDetail.id,
                  repository: leadDetail.repositories[0].origin,
                })
              ).check,
            ),
          ),
        onApprove: () =>
          leadAct(async () => {
            await approveLead({
              id: leadDetail.id,
              version: leadDetail.version,
              digest: leadDetail.digest!,
              approver: "operator (board)",
              relayed: false,
              note: "",
            });
            return "Approved.";
          }),
        onPromote: (origin) =>
          leadAct(async () => {
            const result = await promoteLead({
              ...scope,
              id: leadDetail.id,
              repository: origin,
              board: true,
            });
            if ("backpressured" in result) throw new Error(result.reason);
            if ("accepted" in result)
              return `Promotion ${operationStateLabel(result.operation)} · operation ${result.operation.id}`;
            return `Promoted as ${result.reference}`;
          }),
        onDrop: (reason) =>
          leadAct(async () => {
            await dropLead({ ...scope, id: leadDetail.id, reason });
            return "Dropped.";
          }),
        onReopen: (reason) =>
          leadAct(async () => {
            await reopenLead({
              ...scope,
              id: leadDetail.id,
              reason,
              version: leadDetail.version,
              author: "operator (board)",
            });
            return "Reopened.";
          }),
        onPark: (reason, revisitAt) =>
          leadAct(async () => {
            await parkLead({
              ...scope,
              id: leadDetail.id,
              version: leadDetail.version,
              reason,
              revisitAt,
              author: "operator (board)",
            });
            return revisitAt
              ? "Parked. It will show as due on its recheck date."
              : "Parked.";
          }),
        onUnpark: () =>
          leadAct(async () => {
            await unparkLead({
              id: leadDetail.id,
              version: leadDetail.version,
            });
            return "Back on the to-do list.";
          }),
        onPromoteTo: (kind, reference) =>
          leadAct(async () => {
            await promoteLeadTo({ id: leadDetail.id, kind, reference });
            return kind === "question"
              ? "Recorded as a question."
              : "Recorded as a knowledge change.";
          }),
      }
    : null;
  const leadRead: LeadRead = {
    data: leadDetail,
    error: leadDetailQuery.error ? errorText(leadDetailQuery.error) : undefined,
  };
  return (
    <RecordModal
      label="Lead detail"
      inline={inline}
      title={leadDetail?.title ?? "Lead"}
      compact={compact}
      c={c}
      onClose={onClose}
    >
      <LeadScreen
        read={leadRead}
        actions={leadActions}
        // An earlier version's brief arrives as metadata in lead.get, so a stale check reads it here.
        readVersion={(version) =>
          leadDetail
            ? fetchLeadVersion({ id: leadDetail.id, version })
            : Promise.resolve(null)
        }
        compact={compact}
        busy={busy}
        lane={leadLane ?? undefined}
        c={c}
        onRetry={() => void leadDetailQuery.refetch()}
      />
    </RecordModal>
  );
}
