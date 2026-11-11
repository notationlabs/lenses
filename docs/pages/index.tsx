import { useEffect, useRef, useState, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader } from "@notation/docs/ui";
import { ArrowRight, BookOpen, Check, Copy, GitHub } from "@notation/docs/ui/icon";
import { Ide, Terminal, TypedTerminal, type IdeFile } from "#/views/window";
import { BrowserVsLens } from "#/views/illustrations";
import { Dispatch, Resolvers } from "#/views/scenes";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "lenses – Type-safe APIs for every web app" },
      {
        name: "description",
        content:
          "Lenses turns web pages into functions that return JSON. It runs them in your own Chrome, so a lens can read any page you are signed in to.",
      },
    ],
  }),
  component: LandingPage,
});

const github = "https://github.com/notationlabs/lenses";
const examples = "git:github.com/notationlabs/lenses#main/examples";
const install = "npm install -g @notation/lenses";

const frame = "page-wrap";
const lead = "text-[18px] md:text-[20px] leading-[1.6] text-ink-2";
const skill = "mkdir -p .claude/skills/lenses && lens skill > .claude/skills/lenses/SKILL.md";
const hero = "inline-flex items-center gap-3 rounded-xl px-6 py-3.5 text-[17px] font-medium transition-colors cursor-pointer";
const heading = "text-[1.75rem] md:text-[2.25rem] font-semibold tracking-[-0.03em] leading-tight";
const button =
  "inline-flex items-center gap-2.5 rounded-lg px-5 py-3 text-[16px] font-medium transition-colors cursor-pointer";

function LandingPage() {
  return (
    // Narrows the header and the page content to the same width.
    <div className="flex flex-col min-h-screen bg-surface text-ink font-sans [--page-max-width:1240px]">
      <SiteHeader />
      <main className="flex-1 pb-24">
        <Hero />
        <Focus />
        <PageAsFunction />
        <Features />
        <Interfaces />
        <Install />
      </main>
      <Footer />
    </div>
  );
}

function Hero() {
  return (
    <section className={`${frame} pt-20 md:pt-28 pb-8`}>
      <Row
        text={
          <>
            <h1 className="text-[2.5rem] md:text-[3.75rem] font-extrabold tracking-[-0.04em] leading-[1.05] text-balance">
              Type-safe APIs for every web app
            </h1>
            <p className={`${lead} mt-6`}>
              Lenses turns web pages into functions that return JSON. It runs them in your own Chrome, so a lens can
              read any page you are signed in to.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <AgentMenu />
              <Link
                to="/docs/$"
                params={{ _splat: "manual/introduction" }}
                className={`${hero} bg-card text-ink hover:bg-rule`}
              >
                <BookOpen className="w-[18px] h-[18px]" /> Documentation
              </Link>
            </div>
            <CopyButton
              text={install}
              className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-rule bg-surface px-5 py-3.5 text-left font-mono text-[15px] text-ink-2 hover:border-ink-3 transition-colors cursor-pointer"
            >
              <span>
                <span className="select-none text-ink-3">$ </span>
                {install}
              </span>
            </CopyButton>
          </>
        }
        art={
          <Picture>
            <Dispatch />
          </Picture>
        }
      />
    </section>
  );
}

function AgentMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const item =
    "flex w-full items-center justify-between gap-8 rounded-lg px-4 py-2.5 text-left text-[15px] text-ink hover:bg-card cursor-pointer";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`${hero} bg-ink text-surface hover:bg-ink/85`}
      >
        For agents <UpDown />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-xl border border-rule bg-surface p-1.5 shadow-sm">
          <CopyButton text={skill} className={item}>
            Install the lenses skill
          </CopyButton>
          <CopyButton text={setupPrompt} className={item}>
            Copy the agent prompt
          </CopyButton>
          <div className="my-1.5 mx-2 border-t border-rule" />
          <Link to="/docs/$" params={{ _splat: "manual/agents" }} className={item}>
            Agents and MCP <ArrowRight className="w-4 h-4 opacity-60" />
          </Link>
        </div>
      )}
    </div>
  );
}

function UpDown() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path d="M5 6l3-3 3 3M5 10l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Section({
  id,
  title,
  children,
  panel,
}: {
  id?: string;
  title: string;
  children?: ReactNode;
  panel?: ReactNode;
}) {
  return (
    <section id={id} className={`${frame} pt-20 md:pt-28 scroll-mt-20`}>
      <h2 className={heading}>{title}</h2>
      {children && <div className={`${lead} mt-3 max-w-3xl [&_p+p]:mt-4`}>{children}</div>}
      {panel && <div className="mt-8">{panel}</div>}
    </section>
  );
}

type Tab = { label: string; title: ReactNode; command?: string; source?: string; doc?: { path: string; label: string } };

// A segmented control above one code panel. Only the selected tab is shown.
function TabbedPanel({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(0);
  const tab = tabs[active]!;
  return (
    <>
      <div className="inline-flex gap-1 rounded-lg bg-card p-1">
        {tabs.map((item, index) => (
          <button
            key={item.label}
            type="button"
            onClick={() => setActive(index)}
            className={`rounded-md px-4 py-1.5 text-[15px] cursor-pointer transition-colors ${
              index === active ? "bg-surface text-ink shadow-sm ring-1 ring-rule" : "text-ink-3 hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <Terminal title={tab.title} command={tab.command} source={tab.source} className="mt-4" />
      {tab.doc && (
        <div className="mt-6">
          <DocLink doc={tab.doc.path}>{tab.doc.label}</DocLink>
        </div>
      )}
    </>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-card px-1.5 py-0.5 font-mono text-[0.85em] text-ink">{children}</code>;
}

const lensFiles: IdeFile[] = [
  {
    name: "acme.portal.invoices.json",
    command: "lens call portal/invoices -c ./lenses",
    source: `{
  "name": "@acme/portal/invoices",
  "url": "https://portal.supplier.com/invoices?cursor={params.cursor}",
  "params": { "cursor": { "type": "string", "default": "" } },
  "returns": {
    "type": "object",
    "fields": {
      "invoices": {
        "type": "array",
        "items": {
          "id": "string",
          "total": "number",
          "pdf": { "$lens": "@acme/portal/invoice.pdf", "params": { "id": "$item.id" } }
        }
      },
      "next_page": { "$lens": "@acme/portal/invoices", "params": { "cursor": "$item.next_page" } }
    }
  },
  "resolve": [{
    "kind": "intercept",
    "request": { "method": "GET", "url": "https://portal.supplier.com/api/invoices*" },
    "map": {
      "invoices": "[$res.body.items.{ 'id': id, 'total': total, 'pdf': id }]",
      "next_page": "$res.body.cursor"
    }
  }]
}`,
    output: `{
  "kind": "value",
  "value": {
    "invoices": [
      {
        "id": "INV-2207",
        "total": 1840.5,
        "pdf": { "$lens": "@acme/portal/invoice.pdf", "params": { "id": "INV-2207" } }
      }
    ],
    "next_page": { "$lens": "@acme/portal/invoices", "params": { "cursor": "c2Vlaz01MA" } }
  },
  "resolver": "intercept"
}`,
  },
  {
    name: "acme.portal.invoice.pdf.json",
    command: `lens call portal/invoice.pdf --params '{"id": "INV-2207"}' --out-dir ./invoices`,
    source: `{
  "name": "@acme/portal/invoice.pdf",
  "url": "https://portal.supplier.com/invoices/{params.id}",
  "params": { "id": "string" },
  "returns": { "type": "file" },
  "effects": { "reads": ["portal.supplier.com"], "writes": [] },
  "resolve": [{
    "kind": "http",
    "credentials": true,
    "request": { "method": "GET", "url": "https://portal.supplier.com/api/invoices/{params.id}/pdf" },
    "map": {
      "content": "$res.body.content",
      "encoding": "'base64'",
      "mimeType": "'application/pdf'",
      "name": "$params.id & '.pdf'"
    }
  }]
}`,
    output: `{
  "kind": "value",
  "value": {
    "path": "/Users/you/invoices/INV-2207.pdf",
    "name": "INV-2207.pdf",
    "mimeType": "application/pdf",
    "bytes": 48213
  },
  "resolver": "http"
}`,
  },
  {
    name: "acme.ledger.bills.approve.json",
    command: `lens call ledger/bills.approve --params '{"id": "B-1042"}' --allow-writes -c ./lenses`,
    source: `{
  "name": "@acme/ledger/bills.approve",
  "url": "https://ledger.acme.com/bills/{params.id}",
  "params": { "id": "string" },
  "returns": { "type": "object", "fields": { "status": "string", "approved_at": "string" } },
  "effects": { "reads": ["ledger.acme.com"], "writes": ["ledger (approves a supplier bill)"], "idempotent": false },
  "resolve": [{
    "kind": "http",
    "credentials": "same-origin-page",
    "request": { "method": "POST", "url": "https://ledger.acme.com/api/bills/{params.id}/approve" },
    "body": { "json": "{ 'note': 'Matches invoice ' & $params.id }" },
    "map": { "status": "$res.body.status", "approved_at": "$res.body.approvedAt" },
    "exceptions": { "needs_auth": { "matches": "$res.status = 401" } }
  }],
  "exceptions": {
    "needs_auth": { "hint": "Ask the user to sign in to the ledger in the open tab, then retry this call." }
  }
}`,
    output: `{
  "kind": "outcome",
  "name": "needs_auth",
  "hint": "Ask the user to sign in to the ledger in the open tab, then retry this call."
}

$ lens call ledger/bills.approve --params '{"id": "B-1042"}' --allow-writes -c ./lenses
{
  "kind": "value",
  "value": { "status": "approved", "approved_at": "2026-11-03T10:42:07Z" },
  "resolver": "http"
}`,
  },
  {
    name: "acme.helpdesk.tickets.reply.json",
    command: `lens call helpdesk/tickets.reply --params '{"id": "4471", "message": "Refund sent."}' --allow-writes -c ./lenses`,
    source: `{
  "name": "@acme/helpdesk/tickets.reply",
  "url": "https://help.acme.com/tickets/{params.id}",
  "params": { "id": "string", "message": "string" },
  "tab": "reuse",
  "navigate": "in-page",
  "ready": "[data-testid='ticket-thread']",
  "returns": { "type": "object", "fields": { "status": "string", "last_reply": "string" } },
  "effects": { "reads": ["help.acme.com"], "writes": ["helpdesk (replies to a customer)"], "idempotent": false },
  "perform": [
    { "fill": "[data-testid='reply-box']", "value": "$params.message" },
    { "click": "[data-testid='send-reply']" },
    { "wait": { "increases": "[data-testid='thread-message']" } }
  ],
  "resolve": [
    {
      "kind": "dom",
      "fields": {
        "status": { "selector": ".ticket-status" },
        "last_reply": { "selector": "[data-testid='thread-message']:last-child" }
      }
    },
    { "kind": "llm", "prompt": "Return {status, last_reply} for this support ticket." }
  ]
}`,
    output: `{
  "kind": "value",
  "value": { "status": "Awaiting customer", "last_reply": "Refund sent." },
  "resolver": "dom",
  "performed": true
}`,
  },
];

function PageAsFunction() {
  return (
    <Section title="A page becomes a function" panel={<Ide files={lensFiles} />}>
      <p>
        A lens is a JSON file. It names a page, the parameters the page takes, the shape of the data it returns, and
        how to read that data from the page.
      </p>
      <p>
        Calling the lens opens the page in your browser and returns the data as JSON. Links come back as{" "}
        <Code>$lens</Code> references, so you follow a link by making another call.
      </p>
    </Section>
  );
}

// Narrows a panel in the right-hand column, as on the lightbox site.
function Picture({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-[36rem] mx-auto text-ink">{children}</div>;
}

function DocLink({ doc, children }: { doc: string; children: ReactNode }) {
  return (
    <Link
      to="/docs/$"
      params={{ _splat: doc }}
      className="inline-flex items-center gap-2 rounded-md bg-card px-3 py-2 text-[14px] text-ink hover:bg-rule transition-colors"
    >
      {children} <ArrowRight className="w-3.5 h-3.5 text-accent-ink" />
    </Link>
  );
}

function Row({ text, art }: { text: ReactNode; art: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-8 lg:gap-20">
      <div>{text}</div>
      <div className="self-center min-w-0">{art}</div>
    </div>
  );
}

function Focus() {
  return (
    <section className={`${frame} pt-20 md:pt-28`}>
      <Row
        text={
          <>
            <h2 className={heading}>Focus on the task, not the browser</h2>
            <p className={`${lead} mt-3`}>
              An agent that drives a browser takes a screenshot, clicks, scrolls and reads the page again at every
              step. With a lens it makes one call and gets JSON back. The same question gets the same answer, in a
              form the agent can pass to the next step.
            </p>
          </>
        }
        art={
          <Picture>
            <BrowserVsLens className="w-full max-w-[30rem] mx-auto text-ink" />
          </Picture>
        }
      />
    </section>
  );
}

type Feature = {
  id: string;
  title: string;
  text: ReactNode;
  doc: string;
  link: string;
  panel: ReactNode;
};

const features: Feature[] = [
  {
    id: "call",
    title: "Typed results in one call",
    text: (
      <>
        Name a lens and pass its parameters. The parameters are checked before the call runs, and the result is
        checked against the shape the lens declares in <Code>returns</Code>. If the page changes and the data no
        longer fits, you get an error that lists the mismatches instead of bad data. <Code>lens gen ts-sdk</Code>{" "}
        writes a typed client for a catalog.
      </>
    ),
    doc: "manual/calling",
    link: "Read the manual: Calling lenses",
    panel: (
      <TabbedPanel
        tabs={[
          { label: "Generate", title: "Terminal", command: "lens gen ts-sdk ./examples -o src/lenses.gen.ts" },
          {
            label: "Use",
            title: "src/top.ts",
            source: `import { createLensClient } from "./lenses.gen.js";

const lenses = createLensClient();
const top = await lenses.value({ lens: "hn/top", params: { page: 2 } });

top.stories[0].title; // string`,
          },
        ]}
      />
    ),
  },
  {
    id: "resolvers",
    title: "Cheapest path first",
    text: "A lens lists several ways to get its data, cheapest first: the site's own API, the JSON the page fetches, the rendered HTML, and last the page text read by your model. The call uses the first one that works, and returns the same shape whichever one it used. While the site's API works, no tab opens.",
    doc: "api/resolvers",
    link: "Read the reference: Resolvers",
    panel: <Resolvers />,
  },
  {
    id: "outcomes",
    title: "Sign-ins handled, not hidden",
    text: (
      <>
        The broker makes each request from inside your Chrome, so the site sees your normal session. No password,
        cookie or token leaves the browser. When you are signed out, the call returns a named outcome with a hint, and
        code reads <Code>kind</Code> instead of error text. The agent asks you to sign in, then tries again.
      </>
    ),
    doc: "manual/broker",
    link: "Read the manual: The broker",
    panel: (
      <TypedTerminal
        lines={[
          { prompt: "$", text: "lens call claude/usage --auth-lease-ms 0" },
          { text: "{", pause: 900 },
          { text: '  "kind": "outcome",' },
          { text: '  "name": "needs_auth",' },
          { text: '  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."' },
          { text: "}" },
          { prompt: "$", text: "lens call claude/usage" },
          { text: '{ "kind": "value", "value": { … }, "resolver": "http" }', pause: 1400 },
        ]}
      />
    ),
  },
  {
    id: "writes",
    title: "Writes that are safe to retry",
    text: (
      <>
        A lens that changes something on a site declares it in <Code>effects</Code>. The broker refuses the call
        unless it passes <Code>--allow-writes</Code>. If a write times out, the result says whether the change
        happened, so the agent knows whether to try again.
      </>
    ),
    doc: "manual/write-lenses",
    link: "Read the manual: Write and file lenses",
    panel: (
      <Terminal
        wrap
        title="acme.ledger.bills.approve.json"
        source={`"effects": {
  "writes": ["ledger (approves a supplier bill)"],
  "idempotent": false
}

// after a timeout
{
  "kind": "error",
  "message": "call 7 for @acme/ledger/bills.approve timed out after 60000ms",
  "mutation": { "performed": "no" }
}`}
      />
    ),
  },
  {
    id: "observe",
    title: "Agents write the lenses they need",
    text: (
      <>
        When no lens fits, an agent observes the page, writes a lens file and tests it. <Code>lens observe</Code>{" "}
        lists the JSON requests a page makes, and <Code>lens eval</Code> tries expressions on real responses.
        Catalogs live in git, so you review the pull request like any other code, and every agent gets the new lens.
      </>
    ),
    doc: "manual/authoring",
    link: "Read the manual: Writing a lens",
    panel: (
      <TypedTerminal
        lines={[
          { prompt: "$", text: "lens observe https://portal.supplier.com/invoices" },
          { text: '{ "requests": [{ "method": "GET", "url": "…/api/invoices?cursor=", "status": 200, … }] }', pause: 700 },
          { prompt: "$", text: "lens eval '[$res.body.items.id]' --input invoices.json" },
          { text: '["INV-2207", "INV-2211", "INV-2230"]', pause: 600 },
          { prompt: "$", text: "lens call ./acme.portal.invoices.json" },
          { text: '{ "kind": "value", "value": { "invoices": [ … ] }, "resolver": "intercept" }', pause: 700 },
          { prompt: "$", text: 'gh pr create --title "Add portal/invoices"' },
        ]}
      />
    ),
  },
];

function Features() {
  const [active, setActive] = useState(features[0]!.id);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id);
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    for (const feature of features) {
      const element = document.getElementById(feature.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <section className="pt-20 md:pt-28">
      <h2 className={`${frame} ${heading}`}>Everything an agent needs in one call</h2>
      <nav className="sticky top-[var(--header-height)] z-20 mt-6 bg-surface border-b border-rule">
        <div className={`${frame} py-3`}>
          <div className="flex flex-wrap gap-6 font-mono text-[14px]">
            {features.map((feature) => (
              <a
                key={feature.id}
                href={`#${feature.id}`}
                className={active === feature.id ? "text-ink" : "text-ink-3 hover:text-ink"}
              >
                {feature.id}
              </a>
            ))}
          </div>
        </div>
      </nav>
      <div className={frame}>
        {features.map((feature) => (
          <article
            key={feature.id}
            id={feature.id}
            className="scroll-mt-[calc(var(--header-height)+5rem)] py-12 md:py-14 border-b border-rule last:border-b-0"
          >
            <Row
              text={
                <>
                  <h3 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink">{feature.title}</h3>
                  <p className="mt-3 text-[16px] leading-[1.7] text-ink-2">{feature.text}</p>
                  <div className="mt-8">
                    <DocLink doc={feature.doc}>{feature.link}</DocLink>
                  </div>
                </>
              }
              art={<Picture>{feature.panel}</Picture>}
            />
          </article>
        ))}
      </div>
    </section>
  );
}

const interfaces: Tab[] = [
  {
    label: "CLI",
    doc: { path: "api/cli", label: "Read the reference: CLI" },
    title: "Terminal",
    command: "lens call hn/top --params '{\"page\": 2}' -c ./examples",
    source: `{
  "kind": "value",
  "value": { "stories": [ … ] },
  "resolver": "dom"
}`,
  },
  {
    label: "TypeScript",
    doc: { path: "manual/typescript", label: "Read the manual: TypeScript" },
    title: "src/top.ts",
    source: `import { createLensClient } from "@notation/lenses";

await using lenses = createLensClient({ catalog: ["./examples"] });

const result = await lenses.call({
  lens: "hn/top",
  params: { page: 1 },
});

if (result.kind === "value") {
  console.log(result.value.stories);
} else if (result.kind === "outcome") {
  console.log(result.name, result.hint);
} else {
  console.error(result.message);
}`,
  },
  {
    label: "MCP",
    doc: { path: "manual/agents", label: "Read the manual: Agents and MCP" },
    title: "MCP config",
    source: `{
  "mcpServers": {
    "lenses": {
      "command": "lens-mcp",
      "env": {
        "LENS_CATALOG": "${examples}"
      }
    }
  }
}`,
  },
  {
    label: "GraphQL",
    doc: { path: "manual/graphql", label: "Read the manual: GraphQL" },
    title: "lens graphql playground -c ./examples",
    source: `{
  hn {
    top(page: 1) {
      stories(first: 3) {
        title
        item {                      # one hn/item call per story
          comments(first: 2) { author text }
        }
      }
    }
  }
}`,
  },
];

function Interfaces() {
  return (
    <Section title="Call it from anywhere" panel={<TabbedPanel tabs={interfaces} />}>
      <p>
        The CLI, the TypeScript client, the MCP server and the GraphQL server share one broker and one catalog of lens
        files. Over MCP, every lens in the catalog becomes a tool your agent can call.
      </p>
    </Section>
  );
}

function Install() {
  return (
    <Section id="install" title="Install">
      <div className="mt-8 flex flex-wrap gap-3">
        <CopyCommand text={install} />
        <Link
          to="/docs/$"
          params={{ _splat: "manual/installation" }}
          className={`${button} bg-card text-ink hover:bg-rule`}
        >
          Installation guide
        </Link>
        <Link
          to="/docs/$"
          params={{ _splat: "manual/quickstart" }}
          className={`${button} bg-card text-ink hover:bg-rule`}
        >
          Quick start
        </Link>
      </div>
    </Section>
  );
}

function CopyCommand({ text }: { text: string }) {
  return (
    <CopyButton text={text} className={`${button} bg-ink text-surface font-mono text-[15px] hover:bg-ink/85`}>
      {text}
    </CopyButton>
  );
}

function CopyButton({ text, className, children }: { text: string; className: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={className}
    >
      {children}
      <Icon className="w-4 h-4 opacity-60" />
    </button>
  );
}

function Footer() {
  return (
    <footer className="border-t border-rule">
      <div className={`${frame} py-8 flex flex-wrap items-center justify-between gap-4 text-[14px] text-ink-3`}>
        <p>© 2026 Notation Labs Ltd · Scotland SC765604</p>
        <div className="flex items-center gap-6">
          <Link to="/docs/$" params={{ _splat: "manual/introduction" }} className="hover:text-ink">
            Docs
          </Link>
          <a href={github} className="inline-flex items-center gap-2 hover:text-ink">
            <GitHub className="w-4 h-4" /> GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}

const setupPrompt = `I want my agent to use Lenses. Lenses turns web pages into typed functions that return JSON. It runs them in my own Chrome through a local broker, so a lens can read pages I am signed in to.

First read the manual at ${github}/tree/main/docs/manual, starting with introduction.md, installation.md and agents.md.

1. Check that Node.js 22.12 or later and Google Chrome are installed.
2. Run \`${install}\`.
3. Ask me to install Playwright Extension from the Chrome Web Store, in the Chrome profile I am signed in with.
4. For an agent with a shell, install the skill file: \`mkdir -p .claude/skills/lenses && lens skill > .claude/skills/lenses/SKILL.md\`. For an MCP host, add \`lens-mcp\` to its MCP config instead, with \`LENS_CATALOG\` set to absolute catalog paths.
5. Run \`lens call hn/top -c ${examples}\` to check that calls work.

Do not pass \`--allow-writes\` unless I ask. Report what you installed and the result of each check. Do not commit or push unless I ask.`;
