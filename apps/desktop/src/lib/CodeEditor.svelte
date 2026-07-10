<script lang="ts">
  import { onMount } from "svelte";
  import { basicSetup } from "codemirror";
  import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
  import { Compartment, EditorState } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { tags } from "@lezer/highlight";
  import { loadEditorLanguage } from "./editorSupport";

  let {
    content,
    languageHint = "text",
    readOnly = false,
    onChange,
    onSave,
  }: {
    content: string;
    languageHint?: string;
    readOnly?: boolean;
    onChange: (content: string) => void;
    onSave: () => void;
  } = $props();

  let host: HTMLDivElement;

  onMount(() => {
    const language = new Compartment();
    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSave();
          return true;
        },
      },
    ]);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          language.of([]),
          saveKeymap,
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChange(update.state.doc.toString());
            }
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              color: "var(--poodle-color-text-primary)",
              backgroundColor: "transparent",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "var(--poodle-typography-code-family, monospace)",
              lineHeight: "1.55",
            },
            ".cm-content": {
              padding: "0.75rem 0",
              caretColor: "var(--poodle-color-accent-base)",
            },
            ".cm-line": { padding: "0 0.8rem" },
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: "var(--poodle-color-accent-base)",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
              backgroundColor:
                "color-mix(in srgb, var(--poodle-color-accent-base) 28%, transparent)",
            },
            ".cm-activeLine": {
              backgroundColor:
                "color-mix(in srgb, var(--poodle-color-text-secondary) 5%, transparent)",
            },
            ".cm-gutters": {
              color: "var(--poodle-color-text-muted)",
              backgroundColor: "transparent",
              border: "none",
            },
            ".cm-activeLineGutter": {
              color: "var(--poodle-color-text-secondary)",
              backgroundColor: "transparent",
            },
            ".cm-panels": {
              color: "var(--poodle-color-text-primary)",
              backgroundColor: "var(--poodle-color-background-elevated)",
            },
            ".cm-searchMatch": {
              backgroundColor:
                "color-mix(in srgb, var(--poodle-color-status-warning) 34%, transparent)",
              outline: "none",
            },
            ".cm-searchMatch.cm-searchMatch-selected": {
              backgroundColor:
                "color-mix(in srgb, var(--poodle-color-accent-base) 34%, transparent)",
            },
            "&.cm-focused": { outline: "none" },
          }),
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.comment, color: "var(--poodle-color-text-muted)", fontStyle: "italic" },
              { tag: [tags.keyword, tags.modifier], color: "var(--poodle-color-accent-base)" },
              { tag: [tags.string, tags.special(tags.string)], color: "var(--poodle-color-status-success)" },
              { tag: [tags.number, tags.bool, tags.null], color: "var(--poodle-color-status-warning)" },
              { tag: [tags.typeName, tags.className], color: "var(--poodle-color-text-secondary)" },
              { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--poodle-color-text-primary)" },
              { tag: [tags.invalid, tags.deleted], color: "var(--poodle-color-status-danger)" },
              { tag: tags.heading, color: "var(--poodle-color-text-primary)", fontWeight: "600" },
              { tag: tags.link, color: "var(--poodle-color-accent-base)", textDecoration: "underline" },
            ]),
          ),
        ],
      }),
    });
    let mounted = true;
    void loadEditorLanguage(languageHint).then((extension) => {
      if (mounted) view.dispatch({ effects: language.reconfigure(extension) });
    });
    return () => {
      mounted = false;
      view.destroy();
    };
  });
</script>

<div class="editor-host" bind:this={host}></div>

<style>
  .editor-host {
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }
</style>
