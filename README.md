# Nucleus

Nucleus is an AI-powered development environment built around durable project
management, native coding-agent harness communication, and an engine-first
multi-host architecture.

The project starts with documentation and contracts before behavior. The core
is a portable Rust engine that can be embedded in the Tauri desktop app or
wrapped by local/remote server hosts controlled from desktop, web, mobile, or
CLI clients.

## Start Here

- Project docs: `docs/README.md`
- Current vision: `docs/vision/001-nucleus-product-vision.md`
- Architecture: `docs/architecture/system-architecture.md`
- Roadmap: `docs/roadmaps/README.md`

## Development Surface

Use Effigy first:

```sh
effigy tasks
effigy doctor
effigy test --plan
effigy qa
```

The Rust workspace is intentionally modular. Current crates cover first draft
protocol, agent session lifecycle, adapter registry, project, task, workspace,
engine, orchestration, server boundary, and persistence surfaces; app behavior
remains out of scope until contracts settle.
