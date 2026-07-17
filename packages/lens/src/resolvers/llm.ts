import type { EngineIO, LensResult, LlmResolver } from "../types.js";

// Return the prompt and snapshot to the calling model for extraction.
export async function runLlm(r: LlmResolver, io: EngineIO): Promise<LensResult> {
  const snap = await io.snapshot(r.maxSnapshotChars ?? 20000);
  return {
    kind: "outcome",
    name: "agent_extract",
    value: { prompt: r.prompt, url: snap.url, title: snap.title, text: snap.text },
    resolver: "llm",
  };
}
