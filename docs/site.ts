import type { DocsSite } from "@notation/docs";

export default {
  slug: "lenses",
  label: "Lenses",
  root: new URL(".", import.meta.url),
  defaultSlug: "core/introduction",
  version: { packageJson: "packages/lenses/package.json" },
  categories: [
    {
      label: "Core",
      slug: "core",
      sections: [
        {
          heading: "Getting Started",
          icon: "rocket",
          links: [
            { label: "Introduction", slug: "core/introduction" },
            { label: "Installation", slug: "core/installation" },
            { label: "Quickstart", slug: "core/quickstart" },
          ],
        },
        {
          heading: "Using Lenses",
          icon: "terminal",
          links: [
            { label: "Calling Lenses", slug: "core/calling" },
            { label: "Catalogs", slug: "core/catalogs" },
          ],
        },
        {
          heading: "Consumers",
          icon: "cloud",
          links: [
            { label: "TypeScript SDK", slug: "core/typescript" },
            { label: "Agents & MCP", slug: "core/agents-and-mcp" },
            { label: "GraphQL", slug: "core/graphql" },
          ],
        },
      ],
    },
    {
      label: "Authoring",
      slug: "authoring",
      sections: [
        {
          heading: "Writing Lenses",
          icon: "file-text",
          links: [
            { label: "Writing a Lens", slug: "authoring/writing-a-lens" },
            { label: "Resolvers & Fallbacks", slug: "authoring/resolvers-and-fallbacks" },
            { label: "Write & File Lenses", slug: "authoring/write-and-file-lenses" },
            { label: "Expressions & Templates", slug: "authoring/expressions-and-templates" },
            { label: "Navigation & Auth States", slug: "authoring/navigation-and-auth" },
          ],
        },
      ],
    },
    {
      label: "Reference",
      slug: "reference",
      sections: [
        {
          heading: "Lens Format",
          icon: "book-open",
          links: [
            { label: "Lens Document", slug: "reference/lens-document" },
            { label: "Resolvers & Perform", slug: "reference/resolvers" },
            { label: "Expressions & Templates", slug: "reference/expressions" },
          ],
        },
        {
          heading: "Interfaces & Config",
          icon: "terminal",
          links: [
            { label: "@notation/lenses", slug: "reference/client" },
            { label: "lens CLI", slug: "reference/cli" },
            { label: "lens-mcp Server", slug: "reference/mcp" },
            { label: "@notation/lenses/graphql", slug: "reference/graphql" },
            { label: "Configuration & Paths", slug: "reference/configuration" },
          ],
        },
      ],
    },
    {
      label: "Internals",
      slug: "internals",
      private: true,
      sections: [
        {
          heading: "Overview",
          icon: "layers",
          links: [{ label: "Architecture", slug: "internals/architecture" }],
        },
        {
          heading: "Runtime & Browser",
          icon: "cpu",
          links: [
            { label: "Broker Lifecycle & Auth", slug: "internals/broker-and-auth" },
            { label: "Playwright Relay & Tabs", slug: "internals/playwright-relay" },
            { label: "Captures, Bridge & Downloads", slug: "internals/captures-and-bridge" },
          ],
        },
        {
          heading: "Engine & Validation",
          icon: "database",
          links: [
            { label: "Waterfall & Reconciliation", slug: "internals/waterfall-and-reconciliation" },
            { label: "Expression Checker", slug: "internals/expressions-and-validation" },
          ],
        },
      ],
    },
  ],
} satisfies DocsSite;
