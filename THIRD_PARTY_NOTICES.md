# Third-party notices

## Provider marks

These bundled marks identify the provider associated with a usage reading. They
remain the property of their respective owners; no open-source license is
asserted for them.

- **Claude / Anthropic symbol** — `Anthropic symbol - Ivory.svg` from the
  [Anthropic press kit](https://www.anthropic.com/press-kit). Use is subject to
  [Anthropic's trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines).
- **Codex / OpenAI Blossom** — `OAI_OpenAI-Blossom_White.svg` from the
  [OpenAI logo package](https://cdn.openai.com/brand/openai-logos.zip). Use is
  subject to [OpenAI's brand guidelines](https://openai.com/brand/); its
  monochrome fill follows the theme text colour and identifies an OpenAI service.
- **Grok** — the monochrome logomark paths from the SVG favicon served by
  [grok.com](https://grok.com/images/favicon.svg), with its favicon background
  and visual effects omitted for the compact mark. Use is subject to
  [SpaceXSI's brand guidelines](https://x.ai/legal/brand-guidelines); the mark
  is used only to identify the provider.

The marks are bundled locally as white PNGs rasterised from those SVGs and
cropped to the mark; the client tints them to the theme text colour and makes
no runtime requests for them.

## Vendored BB sidebar (MIT)

Nucleus's BB plugin vendors BB's sidebar thread list (`plugins/thread-list`) to
own the sidebar (Spec 062, decision 5a). BB is MIT; its notice is kept verbatim as
`hosts/bb/plugin/sidebar/LICENSE`.

- **Source** — <https://github.com/get-bb/bb>, commit
  `7b26cae79ec978fafd0a5db0e8517e94f12eb8f4` (tag `desktop-v0.49.0`).
- **Vendored trees** — `hosts/bb/plugin/sidebar/` (the plugin's `app.tsx`, `app/`,
  `shared/`, `server.ts`, its app-level tests and `PLUGIN_OVERVIEW.md`) and the
  component-registry modules written into `hosts/bb/plugin/components/ui/`,
  `hosts/bb/plugin/lib/` and `hosts/bb/plugin/hooks/` by upstream's own fork
  routine.
- **Modifications** — the files are unmodified except where
  `hosts/bb/plugin/sidebar/PATCHES.md` says otherwise. That file names every
  patched and added file and its reason; those modifications are under Nucleus's
  own terms.
- **Record** — `hosts/bb/plugin/sidebar/UPSTREAM.json` holds a SHA-256 per file as
  the pin ships it. A rebase updates this section's commit and tree list.

Copyright 2026 Michael Yong, and the BB contributors, under the MIT licence in
`hosts/bb/plugin/sidebar/LICENSE`.
