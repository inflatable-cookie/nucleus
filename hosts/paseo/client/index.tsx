import type { PluginClientContext } from "@getpaseo/plugin/client";
import { paseoHost, paseoShell } from "./shell";
import { bindBoardShell } from "../../../client/shell";
import { registerNativeQuestionPills } from "../../../client/native-questions";
import { registerDecisionPills } from "../../../client/decision-pill";
import { MainSurface, QueueBoardPanel, registerSettingsOpener } from "../../../client/queue";
import { QueueSettingsScreen } from "../../../client/settings-screen";

/** Spec 026: Queue's native Paseo settings screen and the per-project workspace board. */
const SETTINGS_SCREEN_ID = "northstar-queue-settings";
const BOARD_PANEL_ID = "queue-board";

export default function contribute(client: PluginClientContext) {
  bindBoardShell(paseoShell);
  const host = paseoHost(client);
  const removeSurface = client.addSurface("main", MainSurface);
  const removeSidebarItem = client.addSidebarItem({ id: "queue", title: "Nucleus", icon: "ListTodo", surface: "main" });
  const removeSettings = client.addSettingsScreen({ id: SETTINGS_SCREEN_ID, title: "Nucleus", icon: "Settings", Component: QueueSettingsScreen });
  const removePanel = client.addWorkspacePanel({ id: BOARD_PANEL_ID, title: "Nucleus board", icon: "LayoutDashboard", locations: ["workspace"], context: "workspace", Component: QueueBoardPanel });
  const removeCommand = client.addCommandCenterItem({ id: BOARD_PANEL_ID, title: "Open Nucleus board", icon: "LayoutDashboard", keywords: ["queue", "board", "nucleus", "tasks"], context: "workspace", onSelect: context => context.openPanel(BOARD_PANEL_ID) });
  registerSettingsOpener(section => host.openSettings(SETTINGS_SCREEN_ID, section ? { section } : undefined));
  // Spec 032: a composer pill per asking agent while it has an open decision.
  const removeDecisionPills = registerDecisionPills(host, BOARD_PANEL_ID);
  const removeNativeQuestionPills = registerNativeQuestionPills(host);
  return () => { removeNativeQuestionPills(); removeDecisionPills(); removeCommand(); removePanel(); removeSettings(); removeSidebarItem(); removeSurface(); };
}
