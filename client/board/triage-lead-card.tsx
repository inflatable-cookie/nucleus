import React from "react";
import { Text } from "react-native";
import { RESERVED_LEAD_TAGS, type BoardLead } from "../../shared/contracts";
import { triageKind, triageState } from "../../shared/pipeline-board";
import { BoardCard } from "./cards";
import { RecordChips } from "./badges";
import type { Colors } from "../controls";
import { type as typeScale } from "../design";

/** Owns the shared Lead/Papercut card presentation and its single tag classification. */
export function TriageLeadCard({ lead, eyebrow, selected, c, onSelectLead, onSelectPapercut }: {
  lead: BoardLead;
  eyebrow: React.ReactNode;
  selected: boolean;
  c: Colors;
  onSelectLead: (id: string) => void;
  onSelectPapercut: (id: string) => void;
}) {
  const kind = triageKind(lead);
  return <BoardCard
    label={`Triage: ${lead.title}`}
    c={c}
    eyebrow={eyebrow}
    title={<Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight }}>{lead.title}</Text>}
    chips={<RecordChips c={c} chips={[kind === "papercut" ? RESERVED_LEAD_TAGS.papercut : "Lead"]} />}
    snippet={<Text numberOfLines={1} ellipsizeMode="tail" style={{ color: c.foregroundMuted, fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight }}>{triageState(lead)}</Text>}
    selected={selected}
    onPress={() => kind === "papercut" ? onSelectPapercut(lead.id) : onSelectLead(lead.id)}
  />;
}
