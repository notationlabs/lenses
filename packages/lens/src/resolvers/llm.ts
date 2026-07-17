import type { EngineIO, LensResult, LlmResolver } from "../types.js";

// The calling agent is itself a model, so extraction is handed back to it as
// an `agent_extract` outcome: the author's prompt plus the page snapshot.
export async function runLlm(r: LlmResolver, io: EngineIO): Promise<LensResult> {
  const snap = await io.snapshot(r.maxSnapshotChars ?? 20000);
  return {
    kind: "outcome",
    name: "agent_extract",
    value: { prompt: r.prompt, url: snap.url, title: snap.title, text: snap.text },
    resolver: "llm",
  };
}
