import type { LensParameterDefaults } from "./user-config.js";

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

/** Merge two configurations, with `overrides` winning per pattern and parameter. */
export function mergeParameterDefaults(
  base: LensParameterDefaults,
  overrides: LensParameterDefaults | undefined
): LensParameterDefaults {
  if (!overrides) return base;
  const merged: LensParameterDefaults = { ...base };
  for (const [pattern, values] of Object.entries(overrides)) {
    merged[pattern] = { ...merged[pattern], ...values };
  }
  return merged;
}

/**
 * Apply matching canonical-name globs from least to most specific, then apply
 * explicit call parameters. This makes exact names beat wildcards without
 * depending on object key order for the common case.
 */
export function applyParameterDefaults(
  lens: string,
  supplied: Record<string, unknown>,
  configured: LensParameterDefaults
): Record<string, unknown> {
  const matches = Object.entries(configured)
    .map(([pattern, values], order) => ({
      pattern,
      values,
      order,
      specificity: pattern.replaceAll("*", "").length,
    }))
    .filter(({ pattern }) => globRegex(pattern).test(lens))
    .sort((left, right) => left.specificity - right.specificity || left.order - right.order);

  return Object.assign({}, ...matches.map(({ values }) => values), supplied);
}
