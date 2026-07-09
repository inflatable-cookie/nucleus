<script module lang="ts">
  type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
  };

  const retainedMessages = new Map<string, ChatMessage[]>();
  const retainedModels = new Map<string, string>();
</script>

<script lang="ts">
  import { tick } from "svelte";
  import { Button, Icon, Text } from "@poodle/svelte";
  import { messageSquareText, send } from "@poodle/icons-lucide";
  import { sendAgentChatMessage } from "./control/agentChat";

  let {
    conversationId,
    projectId,
  }: {
    conversationId: string;
    projectId: string | null;
  } = $props();

  let activeConversationId = $state("");
  let messages = $state<ChatMessage[]>([]);
  let draft = $state("");
  let pending = $state(false);
  let failure = $state<string | null>(null);
  let model = $state<string | null>(null);
  let timeline = $state<HTMLElement | null>(null);

  $effect(() => {
    if (activeConversationId !== conversationId) {
      activeConversationId = conversationId;
      messages = retainedMessages.get(conversationId) ?? [];
      model = retainedModels.get(conversationId) ?? null;
    }
  });

  async function submit(): Promise<void> {
    const message = draft.trim();
    if (!projectId || !message || pending) {
      return;
    }

    failure = null;
    pending = true;
    draft = "";
    appendMessage({
      id: `user:${crypto.randomUUID()}`,
      role: "user",
      text: message,
    });

    try {
      const reply = await sendAgentChatMessage({
        conversation_id: conversationId,
        project_id: projectId,
        message,
      });
      model = reply.model;
      retainedModels.set(conversationId, reply.model);
      appendMessage({
        id: reply.turn_id,
        role: "assistant",
        text: reply.assistant_message,
      });
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    } finally {
      pending = false;
      await scrollToLatest();
    }
  }

  function appendMessage(message: ChatMessage): void {
    messages = [...messages, message];
    retainedMessages.set(conversationId, messages);
    void scrollToLatest();
  }

  async function scrollToLatest(): Promise<void> {
    await tick();
    timeline?.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<section class="agent-chat" aria-label="Agent chat">
  <div class="chat-timeline" bind:this={timeline} aria-live="polite">
    {#if messages.length === 0}
      <div class="chat-empty">
        <span class="chat-empty-icon"><Icon icon={messageSquareText} size="md" /></span>
        <Text weight="semibold">Start a conversation</Text>
        <Text tone="muted">
          Chat with Codex in this project. Task controls will be added after the conversation flow is settled.
        </Text>
      </div>
    {:else}
      <div class="message-list">
        {#each messages as message (message.id)}
          <article class:message-user={message.role === "user"} class="chat-message">
            <Text size="sm" tone="muted">{message.role === "user" ? "You" : "Codex"}</Text>
            <div class="message-copy">{message.text}</div>
          </article>
        {/each}
        {#if pending}
          <article class="chat-message chat-message-pending">
            <Text size="sm" tone="muted">Codex</Text>
            <div class="thinking-dots" aria-label="Codex is working"><span></span><span></span><span></span></div>
          </article>
        {/if}
      </div>
    {/if}
  </div>

  <footer class="chat-composer">
    {#if failure}
      <div class="chat-error" role="alert">{failure}</div>
    {/if}
    {#if !projectId}
      <Text tone="muted">Select a project to start a conversation.</Text>
    {/if}
    <div class="composer-row">
      <textarea
        bind:value={draft}
        onkeydown={handleComposerKeydown}
        placeholder={projectId ? "Message Codex" : "Select a project first"}
        aria-label="Message Codex"
        rows="1"
        disabled={!projectId || pending}
      ></textarea>
      <Button
        variant="primary"
        leadingIcon={send}
        onClick={submit}
        disabled={!projectId || !draft.trim() || pending}
      >
        Send
      </Button>
    </div>
    <Text size="xs" tone="muted">
      {model ? `Codex · ${model} · ` : ""}Enter to send · Shift+Enter for a new line · read-only workspace access
    </Text>
  </footer>
</section>

<style>
  .agent-chat {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--poodle-color-background-canvas);
  }

  .chat-timeline {
    min-height: 0;
    overflow: auto;
    padding: clamp(1rem, 4vw, 3rem);
  }

  .chat-empty {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 0.55rem;
    width: min(30rem, 100%);
    min-height: 100%;
    margin: 0 auto;
    text-align: center;
  }

  .chat-empty-icon {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    margin-bottom: 0.2rem;
    color: var(--poodle-color-text-secondary);
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-surface);
  }

  .message-list {
    display: grid;
    gap: 1.5rem;
    width: min(48rem, 100%);
    margin: 0 auto;
  }

  .chat-message {
    display: grid;
    gap: 0.35rem;
    max-width: 90%;
  }

  .message-user {
    justify-self: end;
    width: fit-content;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-surface);
    background: var(--poodle-color-background-surface);
  }

  .message-copy {
    color: var(--poodle-color-text-primary);
    font-size: 0.875rem;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .chat-message-pending {
    min-height: 2.5rem;
  }

  .thinking-dots {
    display: flex;
    gap: 0.28rem;
    align-items: center;
    height: 1.25rem;
  }

  .thinking-dots span {
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 50%;
    background: var(--poodle-color-text-secondary);
    animation: pulse 1.2s infinite ease-in-out;
  }

  .thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.3s; }

  .chat-composer {
    display: grid;
    gap: 0.45rem;
    padding: 0.75rem 1rem 0.8rem;
    border-top: 1px solid var(--poodle-color-border-subtle);
    background: var(--poodle-color-background-panel);
  }

  .composer-row {
    display: flex;
    align-items: end;
    gap: 0.6rem;
  }

  textarea {
    flex: 1;
    min-width: 0;
    min-height: 2.35rem;
    max-height: 9rem;
    resize: vertical;
    padding: 0.58rem 0.7rem;
    color: var(--poodle-color-text-primary);
    font: inherit;
    line-height: 1.35;
    border: 1px solid var(--poodle-color-border-default);
    border-radius: var(--poodle-radius-control);
    outline: none;
    background: var(--poodle-color-background-canvas);
  }

  textarea:focus {
    border-color: var(--poodle-color-border-strong);
  }

  textarea:disabled {
    opacity: 0.55;
  }

  .chat-error {
    padding: 0.55rem 0.65rem;
    color: var(--poodle-color-status-danger);
    font-size: 0.8rem;
    border: 1px solid var(--poodle-color-status-danger);
    border-radius: var(--poodle-radius-control);
  }

  @keyframes pulse {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-0.15rem); }
  }
</style>
