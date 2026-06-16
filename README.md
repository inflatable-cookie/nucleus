# Nucleus

Nucleus is an AI-powered development environment built around durable project
management, native coding-agent harness communication, and a server-first
architecture.

The project starts with documentation and contracts before behavior. The first
implementation target is a Rust workspace plus a Tauri desktop control plane,
but the system core is a Rust server that can later be controlled from desktop,
web, mobile, or CLI clients.

## Start Here

- Project docs: `docs/README.md`
- Current vision: `docs/vision/001-nucleus-product-vision.md`
- Architecture: `docs/architecture/system-architecture.md`
- Roadmap: `docs/roadmaps/g01/001-foundation-and-research.md`

## Development Surface

Use Effigy first:

```sh
effigy tasks
effigy doctor
effigy test --plan
effigy qa
```

The Rust workspace is intentionally small. Current type-only crates cover first
draft protocol, agent session lifecycle, adapter registry, project, task,
workspace, server boundary, and persistence surfaces; app behavior remains out
of scope until contracts settle.

## Next Task

Draft SCM/forge adapter implementation readiness plan.
