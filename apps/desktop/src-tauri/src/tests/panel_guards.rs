#[test]
fn product_workspace_mounts_tasks_and_routes_chat_receipts_to_it() {
    let workspace = include_str!("../../../src/lib/ProjectWorkspaceStage.svelte");
    let chat = include_str!("../../../src/lib/AgentChatPanel.svelte");

    assert!(workspace.contains("import TaskListPanel"));
    assert!(workspace.contains("panel?.kind === \"tasks\""));
    assert!(workspace.contains("<TaskListPanel"));
    assert!(workspace.contains("nucleus:open-task"));
    assert!(workspace.contains("nucleus:open-goal"));
    assert!(workspace.contains("focusPanelKind(\"tasks\")"));
    assert!(workspace.contains("bind:selectedTask"));
    assert!(workspace.contains("bind:selectedGoal"));
    assert!(workspace.contains("activeTask={selectedTask}"));
    assert!(workspace.contains("activeGoal={selectedGoal}"));
    assert!(chat.contains("nucleus:open-task"));
    assert!(chat.contains("nucleus:open-goal"));
    assert!(chat.contains("TaskCreationReceipt"));
    assert!(chat.contains("active_task_id: activeTask?.task_id ?? null"));
    assert!(chat.contains("active_goal_id: activeGoal?.goal_id ?? null"));
    assert!(chat.contains("retainedPendingConversations"));
    assert!(chat.contains("pending = retainedPendingConversations.has(conversationId)"));
    assert!(chat.contains("void scrollToLatest();"));
    assert!(chat.contains("Clear active task context"));
    assert!(chat.contains("Clear active goal context"));
}

#[test]
fn product_workspace_uses_window_regions_without_surface_tabs() {
    let workspace = include_str!("../../../src/lib/ProjectWorkspaceStage.svelte");
    let config = include_str!("../../../src/lib/workspaceUi.ts");

    assert!(workspace.contains("config?.window"));
    assert!(workspace.contains("type WorkspaceWindowDto"));
    assert!(workspace.contains("class=\"window-body\""));
    assert!(!workspace.contains("Workspace surfaces"));
    assert!(!workspace.contains("createWorkspaceSurface"));
    assert!(!workspace.contains("active_surface_id"));
    assert!(config.contains("window: WorkspaceWindowDto"));
    assert!(!config.contains("WorkspaceSurfaceDto"));
}

#[test]
fn editor_panel_constrains_codemirror_to_the_panel_scroll_region() {
    let editor = include_str!("../../../src/lib/EditorPanel.svelte");
    let code_editor = include_str!("../../../src/lib/CodeEditor.svelte");

    assert!(editor.contains("class=\"editor-surface\""));
    assert!(editor.contains(".editor-surface :global(.poodle-surface)"));
    assert!(editor.contains("height: 100%"));
    assert!(code_editor.contains("minHeight: \"0\""));
    assert!(code_editor.contains("overflow: \"auto\""));
}

#[test]
fn diff_panel_shows_the_persisted_current_review_note() {
    let panel = include_str!("../../../src/lib/DiffPanel.svelte");

    assert!(panel.contains("readTaskReviewDecisions"));
    assert!(panel.contains("reviewNext.evidence.review_refs"));
    assert!(panel.contains("currentReview.reason_summary"));
    assert!(panel.contains("Needs changes"));
}

#[test]
fn native_browser_yields_to_top_toolbar_overlays() {
    let app = include_str!("../../../src/App.svelte");
    let browser = include_str!("../../../src/lib/BrowserPanel.svelte");
    let visibility = include_str!("../../../src/lib/nativePanelVisibility.ts");
    let agent_chat = include_str!("../../../src/lib/AgentChatPanel.svelte");
    let diff = include_str!("../../../src/lib/DiffPanel.svelte");
    let editor = include_str!("../../../src/lib/EditorPanel.svelte");

    assert!(app.contains("setNativePanelOverlayIntersection(projectDetailsOverlayId, open"));
    assert!(app.contains("setNativePanelOverlayIntersection(newPanelOverlayId, open"));
    assert!(browser.contains("NATIVE_PANEL_OVERLAY_EVENT"));
    assert!(browser.contains("data-native-browser-viewport"));
    assert!(browser.contains("detail.panelIds.includes(panelId)"));
    assert!(browser.contains("openOverlays.add(detail.id)"));
    assert!(browser.contains("openOverlays.delete(detail.id)"));
    assert!(browser.contains("canShowNativeView()"));
    assert!(visibility.contains("nucleus:native-panel-overlay"));
    assert!(visibility.contains("rectanglesIntersect"));
    assert!(visibility.contains("nativeBrowserPanelId"));
    assert!(!agent_chat.contains("nativePanelVisibility"));
    assert!(!diff.contains("nativePanelVisibility"));
    assert!(!editor.contains("nativePanelVisibility"));
}

#[test]
fn proper_tasks_panel_groups_canonical_goal_membership_without_run_controls() {
    let component = include_str!("../../../src/lib/TaskListPanel.svelte");

    assert!(component.contains("buildStateListQuery(\"goals\")"));
    assert!(component.contains("goal.ordered_task_refs"));
    assert!(component.contains("Ungrouped"));
    assert!(component.contains("selectedGoalId"));
    assert!(!component.contains("task_workflow"));
    assert!(!component.contains("start_task"));
    assert!(!component.contains("run_goal"));
    assert!(!component.contains("execute_goal"));
}
