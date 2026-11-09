import { useEffect, useState, type RefObject } from "react";

// True once the element has been on screen, at the given share of its
// height. It stays true, so an animation it starts plays once.
export function useInView(ref: RefObject<Element | null>, threshold = 0.5) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        setSeen(true);
      },
      { threshold },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return seen;
}

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
