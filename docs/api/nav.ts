import type { DocCategory } from "@notation/docs/config";

export const api: DocCategory = {
  label: "Reference",
  slug: "api",
  sections: [
    {
      heading: "Lens Documents",
      icon: "book-open",
      links: [
        { label: "Lens Document", slug: "api/lens-document" },
        { label: "Resolvers", slug: "api/resolvers" },
        { label: "Expressions and Templates", slug: "api/expressions" },
      ],
    },
    {
      heading: "Interfaces",
      icon: "terminal",
      links: [
        { label: "CLI", slug: "api/cli" },
        { label: "TypeScript Client", slug: "api/client" },
      ],
    },
    {
      heading: "Operation",
      icon: "cpu",
      links: [{ label: "Configuration", slug: "api/configuration" }],
    },
  ],
};
