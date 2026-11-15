import { useState } from "react";
import type { BoardTab } from "./use-board-data";

/** Own the mutually exclusive board records and QA navigation. */
export function useBoardSelection(setTab: (tab: BoardTab) => void) {
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLeadId,setSelectedLeadId] = useState<string|null>(null);
  const [leadLane,setLeadLane] = useState<{key:string;title:string}|null>(null);
  const [openPapercutId,setOpenPapercutId] = useState<string|null>(null);
  const [openDecisionId,setOpenDecisionId] = useState<string|null>(null);
  const [qaFocusId, setQaFocusId] = useState<string | null>(null);
  // Opening a task, decision, lead, papercut or QA run closes whichever other record was open.
  const selectTask = (id: string) => { setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(null); setSelected(id); };
  const selectDecision = (id: string) => { setSelected(null); setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(id); };
  const selectLead = (id: string, lane: {key:string;title:string}|null) => { setSelected(null); setOpenDecisionId(null); setOpenPapercutId(null); setLeadLane(lane); setSelectedLeadId(id); };
  const selectPapercut = (id: string) => { setSelected(null); setOpenDecisionId(null); setSelectedLeadId(null); setOpenPapercutId(id); };
  const openQaRun = (id: string) => { setSelected(null); setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(null); setQaFocusId(id); setTab("qa"); };
  return { selected, setSelected, selectedLeadId, setSelectedLeadId, leadLane, setLeadLane, openPapercutId, setOpenPapercutId, openDecisionId, setOpenDecisionId, qaFocusId, selectTask, selectDecision, selectLead, selectPapercut, openQaRun };
}
