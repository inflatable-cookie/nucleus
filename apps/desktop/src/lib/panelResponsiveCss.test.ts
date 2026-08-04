import { describe, expect, test } from "bun:test";

const panelSources = [
  "TaskListPanel.svelte",
  "AgentChatPanel.svelte",
  "EditorPanel.svelte",
  "DiffPanel.svelte",
  "ForgeDiffPanel.svelte",
];

describe("movable panel responsive ownership", () => {
  for (const file of panelSources) {
    test(`${file} adapts against a named panel container`, async () => {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).toContain("container-name:");
      expect(source).toContain("container-type: inline-size;");
      expect(source).toContain("@container ");
      expect(source).not.toContain("@media (");
    });
  }

  test("the narrow Tasks composition stacks list and detail without chrome overflow", async () => {
    const source = await Bun.file(new URL("TaskListPanel.svelte", import.meta.url)).text();
    expect(source).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(source).toContain("border-bottom: 1px solid var(--poodle-color-border-subtle)");
  });
});
