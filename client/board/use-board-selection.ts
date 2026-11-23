import { useState } from "react";

/** Own the mutually exclusive board records: one task, decision, lead or papercut is open at a time. */
export function useBoardSelection() {
  const [selected, setSelected] = useState<string | null>(null);
  const [rustTaskId, setRustTaskId] = useState<string | null>(null);
  const [selectedLeadId,setSelectedLeadId] = useState<string|null>(null);
  const [leadLane,setLeadLane] = useState<{key:string;title:string}|null>(null);
  const [openPapercutId,setOpenPapercutId] = useState<string|null>(null);
  const [openDecisionId,setOpenDecisionId] = useState<string|null>(null);
  // Opening a task, decision, lead or papercut closes whichever other record was open.
  const clearSelection = () => { setSelected(null); setRustTaskId(null); setSelectedLeadId(null); setLeadLane(null); setOpenPapercutId(null); setOpenDecisionId(null); };
  const selectTask = (id: string) => { clearSelection(); setSelected(id); };
  const selectRustTask = (id: string) => { clearSelection(); setRustTaskId(id); };
  const selectDecision = (id: string) => { clearSelection(); setOpenDecisionId(id); };
  const selectLead = (id: string, lane: {key:string;title:string}|null) => { clearSelection(); setLeadLane(lane); setSelectedLeadId(id); };
  const selectPapercut = (id: string) => { clearSelection(); setOpenPapercutId(id); };
  return { selected, setSelected, rustTaskId, setRustTaskId, selectedLeadId, setSelectedLeadId, leadLane, setLeadLane, openPapercutId, setOpenPapercutId, openDecisionId, setOpenDecisionId, selectTask, selectRustTask, selectDecision, selectLead, selectPapercut, clearSelection };
}
