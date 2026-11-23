import type { DocsSite } from "@notation/docs";
import { categories } from "./categories";

export default {
  slug: "lenses",
  label: "Lenses",
  root: new URL(".", import.meta.url),
  defaultSlug: "core/introduction",
  version: { packageJson: "packages/lenses/package.json" },
  categories,
} satisfies DocsSite;
