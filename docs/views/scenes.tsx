import { useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion, useInView } from "#/views/in-view";
import { TitleBar } from "#/views/window";

// Steps through a scene once it is on screen. `durations[i]` is how long step
// `i` is held. After the last step it starts again at 0. Under reduced motion
// it stays on step `still`.
function useSteps(durations: number[], still = durations.length - 1) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, 0.35);
  const [step, setStep] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (seen) setReduced(prefersReducedMotion());
  }, [seen]);

  useEffect(() => {
    if (!seen || reduced) return;
    const timer = window.setTimeout(() => setStep((step + 1) % durations.length), durations[step]);
    return () => clearTimeout(timer);
  }, [seen, reduced, step, durations]);

  return [ref, reduced ? still : step] as const;
}

function Panel({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="w-full rounded-xl bg-term text-ink shadow-window overflow-hidden">
      <TitleBar>
        <span className="truncate">{title}</span>
      </TitleBar>
      {children}
    </div>
  );
}

const shown = (visible: boolean) =>
  `transition-[opacity,translate] duration-500 ease-out ${visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1"}`;

const heroLog = [
  "http: needs a signed-in page, skipped",
  "intercept: read GET /api/invoices",
  "Checked 24 invoices against returns",
];

const heroDurations = [1600, 1300, 900, 900, 1200, 4200];

// The whole loop in one picture. A question goes to an agent, the agent calls
// a lens, the broker's steps appear one by one, and the answer comes back.
export function Dispatch() {
  const [ref, step] = useSteps(heroDurations);
  const called = step >= 1;
  const lines = Math.max(0, step - 1);
  const answered = step >= 4;
  return (
    <div ref={ref} className="dark w-full flex flex-col text-ink">
      <Message author="you" avatar="bg-[#8b5cf6]" text="Which supplier invoices are still unpaid?" />
      <Wire lit={called} />
      <div
        className={`rounded-xl border bg-term overflow-hidden transition-colors duration-500 ${called ? "border-accent" : "border-rule"}`}
      >
        <div className="h-10 px-4 flex items-center border-b border-rule font-mono text-xs text-ink-2">
          <span className="text-accent-ink">$&nbsp;</span>lens call portal/invoices
        </div>
        <ol className="px-4 py-3 font-mono text-[12.5px] leading-[1.9]">
          {heroLog.map((line, index) => (
            <li key={line} className={`flex gap-2 ${shown(index < lines)}`}>
              <span className="text-accent-ink">›</span>
              <span className="min-w-0 truncate">{line}</span>
            </li>
          ))}
        </ol>
      </div>
      <Wire lit={answered} />
      <div className={shown(answered)}>
        <Message author="agent" avatar="bg-accent" text="Three are unpaid: INV-2207, INV-2211 and INV-2230." />
      </div>
    </div>
  );
}

function Message({ author, avatar, text }: { author: string; avatar: string; text: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl bg-term px-4 py-3 shadow-window">
      <span className={`mt-0.5 w-7 h-7 shrink-0 rounded-full ${avatar}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{author}</p>
        <p className="mt-1 text-[14px] leading-snug">{text}</p>
      </div>
    </div>
  );
}

// A short vertical line between two cards. It turns to the accent colour
// when something has passed along it.
function Wire({ lit }: { lit: boolean }) {
  return <span className={`block w-px h-8 ml-[29px] transition-colors duration-500 ${lit ? "bg-accent" : "bg-rule"}`} />;
}

type Tier = { kind: string; does: string; result: string; works: boolean };

const tiers: Tier[] = [
  { kind: "http", does: "the site's own API", result: "401, next", works: false },
  { kind: "intercept", does: "the JSON the page fetches", result: "Returned", works: true },
  { kind: "dom", does: "the rendered HTML", result: "", works: false },
  { kind: "llm", does: "the page text, read by your model", result: "", works: false },
];

// 0: idle. 1: http is tried. 2: http fails. 3: intercept is tried.
// 4: intercept returns, and dom and llm are never tried.
const resolverDurations = [900, 1000, 700, 1000, 3800];

// The resolvers of one lens, cheapest first. The call falls through them in
// order and stops at the first one that returns data.
export function Resolvers() {
  const [ref, step] = useSteps(resolverDurations);
  return (
    <div ref={ref} className="dark w-full">
      <Panel title="@acme/portal/invoices · resolve">
        <ul>
          {tiers.map((tier, index) => {
            const trying = step === index * 2 + 1;
            const settled = step >= index * 2 + 2 && index < 2;
            const skipped = step >= 4 && index >= 2;
            return (
              <li
                key={tier.kind}
                className={`grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 border-b border-rule last:border-b-0 transition-opacity duration-500 ${skipped ? "opacity-40" : ""}`}
              >
                <span
                  className={`font-mono text-[13px] transition-colors duration-300 ${trying || (settled && tier.works) ? "text-accent-ink" : "text-ink"}`}
                >
                  {tier.kind}
                </span>
                <span className="min-w-0 truncate text-[13.5px] text-ink-2">{tier.does}</span>
                <span
                  className={`text-xs transition-opacity duration-300 ${tier.works ? "text-accent-ink" : "text-ink-3"} ${trying || settled || skipped ? "opacity-100" : "opacity-0"}`}
                >
                  {trying ? "Trying…" : skipped ? "Not tried" : tier.result}
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
