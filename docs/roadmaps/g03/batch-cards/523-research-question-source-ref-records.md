# 523 Research Question Source Ref Records

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Add research question and source reference vocabulary.

## Work

- [x] Add research question ids, priority, status, and open gap refs.
- [x] Add source ref records for web pages, official docs, source repos, code
  files, issues/discussions, papers, PDFs, package registries, local files,
  human notes, model-generated leads, and custom refs.
- [x] Add source reliability and retrieval-method hints without retrieval
  behavior.

## Acceptance Criteria

- [x] Source refs preserve provenance without retaining raw source payloads.
- [x] Model-generated leads are represented as leads, not evidence.
- [x] Question/source records do not grant crawling, browser, provider, or
  promotion authority.

## Evidence

- `cargo test -p nucleus-research`
