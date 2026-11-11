import type { PluginClientContext } from "@getpaseo/plugin/client";
import { paseoHost, paseoShell } from "./shell";
import { registerNucleusSidebar } from "./sidebar";
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
  // Spec 059 step 2 / nucleus#1123: where the host carries plugin screens and custom
  // sidebar rows, the board is one titled "Nucleus" screen and the one Nucleus row
  // (board button plus usage rings) opens it, so neither Paseo's native sidebar item
  // nor the plugin's own "main" surface is registered — nothing appears twice. Older
  // hosts keep the surface and the native item, and render no rings.
  const sidebar = registerNucleusSidebar(client);
  const removeSurface = sidebar.combined
    ? () => {}
    : client.addSurface("main", MainSurface);
  const removeSidebarItem = sidebar.combined
    ? () => {}
    : client.addSidebarItem({ id: "queue", title: "Nucleus", icon: "ListTodo", surface: "main" });
  const removeSettings = client.addSettingsScreen({ id: SETTINGS_SCREEN_ID, title: "Nucleus", icon: "Settings", Component: QueueSettingsScreen });
  const removePanel = client.addWorkspacePanel({ id: BOARD_PANEL_ID, title: "Nucleus board", icon: "LayoutDashboard", locations: ["workspace"], context: "workspace", Component: QueueBoardPanel });
  const removeCommand = client.addCommandCenterItem({ id: BOARD_PANEL_ID, title: "Open Nucleus board", icon: "LayoutDashboard", keywords: ["queue", "board", "nucleus", "tasks"], context: "workspace", onSelect: context => context.openPanel(BOARD_PANEL_ID) });
  registerSettingsOpener(section => host.openSettings(SETTINGS_SCREEN_ID, section ? { section } : undefined));
  // Spec 032: a composer pill per asking agent while it has an open decision.
  const removeDecisionPills = registerDecisionPills(host, BOARD_PANEL_ID);
  const removeNativeQuestionPills = registerNativeQuestionPills(host);
  return () => {
    sidebar.remove();
    removeNativeQuestionPills();
    removeDecisionPills();
    removeCommand();
    removePanel();
    removeSettings();
    removeSidebarItem();
    removeSurface();
  };
}
