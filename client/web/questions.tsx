import { useEffect, useMemo } from "react";
import { useBoardState } from "../board-state";
import { bindWebQuestions, updateWebQuestions } from "../native-questions";
import { useRpc } from "./shell";
import { nativeQuestionList, nativeQuestionAnswer } from "../../shared/contracts";
import { formatAgentId } from "../../shared/agent-identity";

/** The shared task cards read this observer; the web has no composer pills. */
export function WebQuestions() {
  const { state } = useBoardState();
  const list = useRpc(nativeQuestionList), answer = useRpc(nativeQuestionAnswer);
  const owners = useMemo(() => {
    const result = new Map<string, string>();
    for (const task of state?.tasks ?? []) {
      const hostId = task.hostId ?? state?.hostId;
      if (hostId) for (const id of task.questionAgentIds ?? []) result.set(formatAgentId(hostId, id), task.id);
    }
    return result;
  }, [state?.tasks]);
  useEffect(() => bindWebQuestions(async (agentId, requestId, answers) => {
    const taskId = owners.get(agentId);
    if (!taskId) throw Error("The question thread is no longer on this board");
    await answer({ taskId, agentRef: agentId, requestId, answers });
    updateWebQuestions(agentId, []);
  }), [owners, answer]);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      await Promise.all([...owners].map(async ([agentId, taskId]) => {
        try {
          const requests = await list({ taskId, agentRef: agentId });
          if (!stopped) updateWebQuestions(agentId, requests.map(request => ({ id: request.requestId, questions: request.questions })));
        } catch { if (!stopped) updateWebQuestions(agentId, []); }
      }));
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => { stopped = true; clearInterval(timer); for (const id of owners.keys()) updateWebQuestions(id, []); };
  }, [owners, list]);
  return null;
}
