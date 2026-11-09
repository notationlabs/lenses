import { useId } from "react";

// Must default-export a component
export default function Logo() {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xl font-black tracking-[-0.03em]">lenses</span>
      <LensMark className="h-[18px] mt-0.5" />
    </div>
  );
}

export function LensMark({ className = "" }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 40 24" className={className} aria-hidden>
      <defs>
        <radialGradient id={id} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#fff1e8" />
          <stop offset="0.35" stopColor="#ffb39a" />
          <stop offset="0.7" stopColor="#fe5537" />
          <stop offset="1" stopColor="#8a2be2" />
        </radialGradient>
      </defs>
      <path
        d="M9 2.5c-3 0-4 1.2-4 3.5v2.6c0 1.7-.9 2.9-3 3.4 2.1.5 3 1.7 3 3.4V18c0 2.3 1 3.5 4 3.5M31 2.5c3 0 4 1.2 4 3.5v2.6c0 1.7.9 2.9 3 3.4-2.1.5-3 1.7-3 3.4V18c0 2.3-1 3.5-4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="12" r="7.2" fill={`url(#${id})`} />
      <circle cx="17.6" cy="9.6" r="1.9" fill="#fff" opacity={0.75} />
    </svg>
  );
}
