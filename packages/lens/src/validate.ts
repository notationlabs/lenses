import type { LensSpec } from "./types.js";

export function validateSpec(raw: unknown): LensSpec {
  if (typeof raw !== "object" || raw === null) throw new Error("lens spec must be an object");
  const s = raw as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof s.lens !== "string" || !/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(s.lens))
    problems.push(`"lens" must be a namespaced name like "hn/top"`);
  if (typeof s.version !== "number") problems.push(`"version" must be a number`);
  if (!Array.isArray(s.accepts) || s.accepts.length === 0 || !s.accepts.every((a) => typeof a === "string"))
    problems.push(`"accepts" must be a non-empty array of URL patterns`);

  const effects = s.effects as Record<string, unknown> | undefined;
  if (!effects || !Array.isArray(effects.reads) || !Array.isArray(effects.writes))
    problems.push(`"effects" must declare "reads" and "writes" arrays`);

  if (!Array.isArray(s.resolve) || s.resolve.length === 0) {
    problems.push(`"resolve" must be a non-empty array`);
  } else {
    s.resolve.forEach((r, i) => {
      const kind = (r as Record<string, unknown>)?.kind;
      if (kind !== "intercept" && kind !== "dom" && kind !== "llm")
        problems.push(`resolve[${i}].kind must be intercept | dom | llm`);
      if (kind === "intercept" && typeof (r as Record<string, unknown>).request !== "string")
        problems.push(`resolve[${i}] intercept needs a "request" pattern`);
      if (kind === "llm" && typeof (r as Record<string, unknown>).prompt !== "string")
        problems.push(`resolve[${i}] llm needs a "prompt"`);
    });
  }

  if (problems.length) throw new Error(`invalid lens spec:\n- ${problems.join("\n- ")}`);
  return raw as LensSpec;
}
