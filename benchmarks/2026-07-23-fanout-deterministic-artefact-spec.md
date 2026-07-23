# Bench #5 spec: fan-out task, deterministic-artefact steelman

Status: spec only — not yet executed.

## Premise

Bench #4 compared per-run agent cost, which under-credits the lens property that
matters most: after run 1 a sound lens is deterministic — `lens call` in a shell
script, zero agent tokens. #4 also let the devtools control author its artefact
incidentally (notes + an unused script). This round steelmans the control by
*requiring* a rerunnable artefact, and measures the tier #4 never did: execution
with no agent at all.

Since the broker moved to CDP (5a0076c), both arms attach to the same real,
signed-in Chrome (144+ consent-gated remote debugging). Session reach is no
longer a differentiator; this bench isolates artefact quality.

## Task (fan-out, multi-call by construction)

From Hacker News: take the top 5 front-page stories, fetch the top comments for
each, and produce a cross-story summary (per story: title, score, one-line
comment sentiment; plus one overall paragraph). Requires ≥6 page reads — a
front-page read fanning out to 5 item reads. Single-shot answers can't hide
per-call costs.

## Arms

- **chrome-devtools MCP** — prompt requires it to leave a rerunnable artefact:
  "save a script that reproduces the data collection (not the summary) with no
  agent involvement; it may drive Chrome over CDP".
- **Lenses CLI** — authors lens(es); the lens documents are the artefact. The
  `$lens` follow-up references (front page → item) are in scope and should be
  exercised rather than hand-built URLs.

## Conditions (per arm)

| Tier | What runs | What it measures |
|---|---|---|
| 1 cold | agent does the task from scratch, must leave the artefact | authoring cost |
| 2 agent reuse | fresh agent, given only the artefact path, repeats the task | marginal agent cost per multi-call task |
| 3 deterministic | artefact executed bare (shell, no agent); output diffed against tier 2 data | the zero-token tier; soundness-after-run-1 |
| 4 perturbation | tier 3 re-run under a changed condition (Chrome closed, or HN front page rolled over) | failure quality: typed outcome / clear error vs stack trace or silent garbage |

## Metrics

- Tokens, wall time, tool calls per tier (tiers 3–4: agent tokens = 0 by
  construction; record wall time and exit behaviour).
- **Soundness after run 1** (headline): does the artefact produce correct,
  schema-valid data in tier 3 without intervention?
- Failure quality in tier 4, scored qualitatively (named outcome > clear error >
  stack trace > wrong data).
- Note where the control's authoring cost converges toward lens authoring cost —
  determinism isn't free for anyone.

## Predictions (falsifiable, made before running)

1. Control authoring cost rises well above #4's ~13k once the rerunnable-script
   requirement bites.
2. Lens agent-reuse beats control agent-reuse by more than #4's margin, because
   the fan-out multiplies per-call savings (~1k/call vs browse-per-story).
3. Both artefacts can pass tier 3; the differentiation shows up in tier 4
   (declared outcomes and schema violations vs ad-hoc script failure).

## Execution notes

- Executor model: Opus for all agent tiers (model-axis question deferred to a
  later round; see the authoring-model discussion — post-fix legibility should
  be retested with Sonnet separately).
- Control agents run serially (shared browser); lens agents may run via broker.
- HN front page churns: capture tier-2/3 runs close together and diff on
  structure, not exact stories, if rollover occurs.
- n=1 per cell, same caveat as #4.
