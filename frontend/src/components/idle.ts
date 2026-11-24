import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Controls fade out this long after the pointer last moved, unless it rests on one. */
const IDLE_MS = 2500;
export const fade = (idle: boolean) => `transition-opacity duration-300 ${idle ? "pointer-events-none opacity-0" : ""}`;

const HOLDS =
  "[data-control]:hover, [data-control]:focus-visible, [data-control] :focus-visible, [data-control] [aria-expanded=true]";

export function useIdle(root: RefObject<HTMLElement | null>): [boolean, () => void] {
  const [idle, setIdle] = useState(false);
  const timer = useRef(0);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(timer.current);
    const check = () => {
      if (root.current?.querySelector(HOLDS)) {
        timer.current = window.setTimeout(check, IDLE_MS);
      } else {
        setIdle(true);
      }
    };
    timer.current = window.setTimeout(check, IDLE_MS);
  }, [root]);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, [wake]);
  return [idle, wake];
}
