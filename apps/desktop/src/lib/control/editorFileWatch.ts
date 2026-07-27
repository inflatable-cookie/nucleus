import { Channel, invoke } from "@tauri-apps/api/core";

export type EditorFileWatchEvent =
  | {
      kind: "changed";
      subscription_id: string;
      project_id: string;
      resource_id: string;
      paths: string[];
    }
  | {
      kind: "scm_changed";
      subscription_id: string;
      project_id: string;
      resource_id: string;
    }
  | {
      kind: "failed";
      subscription_id: string;
      project_id: string;
      message: string;
    };

export async function watchEditorFiles(
  projectId: string,
  resourceIds: string[],
  onEvent: (event: EditorFileWatchEvent) => void,
): Promise<() => Promise<void>> {
  const channel = new Channel<EditorFileWatchEvent>();
  channel.onmessage = onEvent;
  const subscriptionId = await invoke<string>("editor_file_watch_start", {
    projectId,
    resourceIds,
    onEvent: channel,
  });
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    await invoke("editor_file_watch_stop", { subscriptionId });
  };
}
