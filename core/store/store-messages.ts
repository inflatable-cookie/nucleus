import { agentMessageRecordSchema, type AgentMessageRecord } from "../../shared/contracts";
import { StoreCore } from "./store-core";

interface MessageAccess {
  taskChanged(taskId: string): void;
}

const parseMessage = (data: unknown): AgentMessageRecord => agentMessageRecordSchema.parse(JSON.parse(String(data)));

/** Agent-to-agent messages between task roles (Spec 058 rollout step 3). */
export class StoreMessages {
  constructor(private readonly core: StoreCore, private readonly access: MessageAccess) {}

  /** A task's worker messages, sent and received, oldest first. */
  messages(taskId: string): AgentMessageRecord[] {
    return (this.core.db.prepare("SELECT data FROM task_messages WHERE fromTaskId=? OR toTaskId=? ORDER BY rowid").all(taskId, taskId) as { data: string }[])
      .map(row => parseMessage(row.data));
  }

  /** Every message still waiting for its recipient role's next turn, oldest first. */
  queuedMessages(): AgentMessageRecord[] {
    return (this.core.db.prepare("SELECT data FROM task_messages WHERE json_extract(data,'$.status')='queued' ORDER BY rowid").all() as { data: string }[])
      .map(row => parseMessage(row.data));
  }

  message(id: string): AgentMessageRecord | null {
    const row = this.core.db.prepare("SELECT data FROM task_messages WHERE id=?").get(id) as { data: string } | undefined;
    return row ? parseMessage(row.data) : null;
  }

  /**
   * The one message whose reply handle this is (nucleus#1387). A handle is issued to
   * exactly one message, so the newest match is also the only match.
   */
  messageByReplyTo(replyTo: string): AgentMessageRecord | null {
    if (!replyTo) return null;
    const row = this.core.db
      .prepare("SELECT data FROM task_messages WHERE json_extract(data,'$.replyTo')=? ORDER BY rowid DESC LIMIT 1")
      .get(replyTo) as { data: string } | undefined;
    return row ? parseMessage(row.data) : null;
  }

  putMessage(record: AgentMessageRecord) {
    this.core.db.prepare("INSERT INTO task_messages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(record.id, record.fromTaskId, record.toTaskId, JSON.stringify(record));
    this.core.advanceRevision();
    this.access.taskChanged(record.fromTaskId);
    this.access.taskChanged(record.toTaskId);
  }
}
