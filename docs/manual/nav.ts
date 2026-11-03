import type { DocCategory } from "@notation/docs/config";

export const manual: DocCategory = {
  label: "User Manual",
  slug: "manual",
  sections: [
    {
      heading: "Getting Started",
      icon: "rocket",
      links: [
        { label: "Introduction", slug: "manual/introduction" },
        { label: "Installation", slug: "manual/installation" },
        { label: "Quick Start", slug: "manual/quickstart" },
      ],
    },
    {
      heading: "Using Lenses",
      icon: "terminal",
      links: [
        { label: "Calling Lenses", slug: "manual/calling" },
        { label: "Catalogs", slug: "manual/catalogs" },
      ],
    },
    {
      heading: "Consumers",
      icon: "plug",
      links: [
        { label: "TypeScript", slug: "manual/typescript" },
        { label: "Agents and MCP", slug: "manual/agents" },
        { label: "GraphQL", slug: "manual/graphql" },
      ],
    },
    {
      heading: "Authoring",
      icon: "code",
      links: [
        { label: "Writing a Lens", slug: "manual/authoring" },
        { label: "Write and File Lenses", slug: "manual/write-lenses" },
      ],
    },
    {
      heading: "Runtime",
      icon: "layers",
      links: [{ label: "Broker and Browser", slug: "manual/broker" }],
    },
  ],
};
