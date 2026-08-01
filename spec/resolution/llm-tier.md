---
title: Resolve through the llm tier
---

# Resolve through the llm tier

## Context

The llm tier hands extraction to the calling agent's own model. Evidence: `packages/lens/src/resolvers/llm.ts`.

## Outcomes

- **Agent-extract outcome:** The tier always returns the outcome `agent_extract` whose value carries the declared `prompt` and the page snapshot's `url`, `title`, and `text`.
- **Snapshot cap:** The snapshot text is capped at `maxSnapshotChars`, default 20000 characters.

## Invariants

- **No provider selection:** The client never selects or calls an LLM provider; the consumer's own model performs the extraction.
