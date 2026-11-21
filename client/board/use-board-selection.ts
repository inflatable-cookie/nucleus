import { useState } from "react";

/** Own the mutually exclusive board records: one task, decision, lead or papercut is open at a time. */
export function useBoardSelection() {
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLeadId,setSelectedLeadId] = useState<string|null>(null);
  const [leadLane,setLeadLane] = useState<{key:string;title:string}|null>(null);
  const [openPapercutId,setOpenPapercutId] = useState<string|null>(null);
  const [openDecisionId,setOpenDecisionId] = useState<string|null>(null);
  // Opening a task, decision, lead or papercut closes whichever other record was open.
  const selectTask = (id: string) => { setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(null); setSelected(id); };
  const selectDecision = (id: string) => { setSelected(null); setSelectedLeadId(null); setOpenPapercutId(null); setOpenDecisionId(id); };
  const selectLead = (id: string, lane: {key:string;title:string}|null) => { setSelected(null); setOpenDecisionId(null); setOpenPapercutId(null); setLeadLane(lane); setSelectedLeadId(id); };
  const selectPapercut = (id: string) => { setSelected(null); setOpenDecisionId(null); setSelectedLeadId(null); setOpenPapercutId(id); };
  const clearSelection = () => { setSelected(null); setSelectedLeadId(null); setLeadLane(null); setOpenPapercutId(null); setOpenDecisionId(null); };
  return { selected, setSelected, selectedLeadId, setSelectedLeadId, leadLane, setLeadLane, openPapercutId, setOpenPapercutId, openDecisionId, setOpenDecisionId, selectTask, selectDecision, selectLead, selectPapercut, clearSelection };
}
