import { useId } from "react";

const accent = "var(--color-accent)";
const rule = "var(--color-rule)";
const card = "var(--color-card)";
const faint = "var(--color-ink-3)";

function Label({ x, y, children, fill = faint, anchor = "start" }: {
  x: number;
  y: number;
  children: string;
  fill?: string;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text x={x} y={y} fill={fill} textAnchor={anchor} fontSize={13} fontFamily="var(--font-mono)">
      {children}
    </text>
  );
}

function Agent({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={9} fill="currentColor" />;
}

function Data({ x, y, stroke }: { x: number; y: number; stroke: string }) {
  return (
    <g>
      <rect x={x - 22} y={y - 18} width={44} height={36} rx={7} fill={card} stroke={stroke} strokeWidth={1.5} />
      <Label x={x} y={y + 4.5} fill="currentColor" anchor="middle">
        {"{ }"}
      </Label>
    </g>
  );
}

// Driving a browser is a long path through many steps. A lens call is one
// straight line to the same data.
export function BrowserVsLens({ className = "" }: { className?: string }) {
  const id = useId();
  const steps: [number, number][] = [
    [96, 44],
    [140, 128],
    [186, 52],
    [232, 136],
    [278, 46],
    [324, 126],
    [370, 60],
  ];
  const path = `M44 90 ${steps.map(([x, y]) => `L${x} ${y}`).join(" ")} L414 90`;
  return (
    <svg viewBox="0 0 480 300" className={className} role="img" aria-label="A browser takes many steps; a lens takes one call">
      <defs>
        <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 1L9 5L0 9Z" fill={accent} />
        </marker>
      </defs>
      <Label x={24} y={22}>
        browser
      </Label>
      <path d={path} fill="none" stroke={faint} strokeWidth={1.5} strokeDasharray="4 5" strokeLinejoin="round" />
      {steps.map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r={5} fill="var(--color-surface)" stroke={faint} strokeWidth={1.5} />
      ))}
      <Agent x={44} y={90} />
      <Data x={436} y={90} stroke={rule} />

      <line x1={24} x2={456} y1={190} y2={190} stroke={rule} />

      <Label x={24} y={222}>
        lens
      </Label>
      <line x1={58} x2={406} y1={256} y2={256} stroke={accent} strokeWidth={2} markerEnd={`url(#${id})`} />
      <Agent x={44} y={256} />
      <Data x={436} y={256} stroke={accent} />
    </svg>
  );
}
