import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@notation/docs/ui";

// The landing page, a consumer-owned TanStack route
export const Route = createFileRoute("/")({
  component: () => (
    <>
      <SiteHeader />
      {/* landing content; see pok's views/landing for a full example */}
    </>
  ),
});
