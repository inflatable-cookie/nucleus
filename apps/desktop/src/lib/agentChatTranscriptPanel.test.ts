import { describe, expect, test } from "bun:test";

describe("agent chat panel composition", () => {
  test("desktop composition keeps activity, cancellation, and receipts together", async () => {
    const panel = await Bun.file(
      new URL("./AgentChatPanel.svelte", import.meta.url),
    ).text();

    expect(panel).toContain("AgentTranscript");
    expect(panel).toContain('listen<AgentChatActivity>("agent-chat:activity"');
    expect(panel).toContain('listen<AgentChatQuestionExchange>("agent-chat:question"');
    expect(panel).toContain('"agent-chat:subagents"');
    expect(panel).toContain("selectAgentChatActor");
    expect(panel).toContain("onOpenChild={(childId) => void chooseActor(childId)}");
    expect(panel).toContain('status={pendingQuestion ? "questioning"');
    expect(panel).toContain("answerAgentChatQuestion");
    expect(panel).toContain("cancelAgentChatTurn(projectId, conversationId)");
    expect(panel).toContain("await hydrateHistory(projectId, conversationId)");
    expect(panel).toContain("TaskCreationReceipt");
    expect(panel).toContain("TaskWorkflowReceipt");
  });
});

describe("agent chat actor selector placement", () => {
  test("rides with the composer as a chip whenever attributed work exists", async () => {
    const panel = await Bun.file(
      new URL("./AgentChatPanel.svelte", import.meta.url),
    ).text();

    // The ghost selector no longer rides the transcript shell.
    expect(panel).not.toMatch(/class="actor-navigation"/);

    // Composer-zone placement: inside the floating composer, directly above
    // the input, so it sits where the operator's attention is.
    expect(panel).toMatch(
      /class="composer-float"[\s\S]*actorSelectorVisible[\s\S]*<AgentChatInput/,
    );

    // Visibility: directories exist, or the current selection is a child —
    // including a dangling one, so a stuck child view always has a way back.
    expect(panel).toContain(
      'subagentDirectories.length > 0 || actorSelection.kind === "subagent"',
    );

    // Chip trigger: icon + current actor label + reflected child status,
    // matching the composer's chip row rather than ghost text.
    expect(panel).toContain('class="actor-selector-chip"');
    expect(panel).toContain("actorChipLabel");
    expect(panel).toContain("StatusIndicator");
    expect(panel).toContain('"All work"');
    expect(panel).toContain('"Primary"');
    expect(panel).toContain('"git-branch"');

    // All work remains the return path through the same chooser.
    expect(panel).toContain("onOpenChild={(childId) => void chooseActor(childId)}");
  });

  test("resets a dangling child selection to All work on hydrate and directory events", async () => {
    const panel = await Bun.file(
      new URL("./AgentChatPanel.svelte", import.meta.url),
    ).text();

    // Both hydration and directory events run the reconcile.
    expect(panel).toMatch(
      /retain\(retainedActorSelections, nextConversationId, actorSelection\);[\s\S]{0,200}void reconcileActorSelection\(\);/,
    );
    expect(panel).toMatch(
      /retain\(retainedSubagentDirectories, conversationId, subagentDirectories\);[\s\S]{0,200}void reconcileActorSelection\(\);/,
    );

    // The reconcile only fires for a subagent selection, only when no
    // directory entry matches the operation and child, and the reset
    // persists through the server so durable state agrees.
    expect(panel).toMatch(
      /async function reconcileActorSelection\(\)[\s\S]*actorSelection\.kind !== "subagent"[\s\S]*runtime_operation_id === actorSelection\.runtime_operation_id[\s\S]*subagent\.subagent_id === actorSelection\.actor_id[\s\S]*actorSelectionFor\("all"\)[\s\S]*selectAgentChatActor\(fallback\)/,
    );
  });
});
