import type { DocCategory } from "@notation/docs/config";

// Each category owns a nav.ts beside its Markdown.
// A page is unreachable until registered here.
export const manual: DocCategory = {
  label: "User Manual",
  slug: "manual",
  sections: [
    {
      heading: "Getting Started",
      icon: "rocket", // framework icon registry key
      links: [{ label: "Introduction", slug: "manual/introduction" }],
    },
  ],
};
