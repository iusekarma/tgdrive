import { MoreVertical } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { ICON_BUTTON } from "./ui";

/** Space kept between a menu and its button, and the window's edges. */
const GAP = 6;
const EDGE = 8;

const items = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[role^=menuitem]")];

/**
 * The menu itself, in the browser's top layer: it is never clipped by a
 * scrolling panel, covered by a sticky bar, or hidden behind an open dialog. It opens
 * upwards where there is more room above its button.
 */
function Popup({
  button,
  label,
  align,
  width,
  onClose,
  children,
}: {
  button: RefObject<HTMLButtonElement | null>;
  label: string;
  align: "start" | "end";
  width: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = button.current?.getBoundingClientRect();
    if (!el || !anchor) return;
    if (!el.matches(":popover-open")) el.showPopover();
    const below = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const up = el.offsetHeight > below && above > below;
    el.style.maxHeight = `${Math.max(up ? above : below, 120)}px`;
    const left = align === "end" ? anchor.right - el.offsetWidth : anchor.left;
    el.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - el.offsetWidth - EDGE))}px`;
    el.style.top = `${up ? anchor.top - GAP - el.offsetHeight : anchor.bottom + GAP}px`;
    el.focus({ preventScroll: true });
  }, [align, button]);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (ref.current?.contains(target) || button.current?.contains(target));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) close.current();
    };
    // The button moves away from under it.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && ref.current?.contains(e.target))) close.current();
    };
    const onResize = () => close.current();
    // Captured, so the page's own shortcuts stay out of it while it is open.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const el = ref.current;
      if (!el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        button.current?.focus();
        return;
      }
      if (e.key === "Tab") return close.current();
      const list = items(el);
      const at = list.indexOf(document.activeElement as HTMLElement);
      const to =
        e.key === "ArrowDown" ? (at + 1) % list.length
        : e.key === "ArrowUp" ? (at <= 0 ? list.length : at) - 1
        : e.key === "Home" ? 0
        : e.key === "End" ? list.length - 1
        : -1;
      if (to < 0) return;
      e.preventDefault();
      list[to]?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [button]);

  return (
    <div
      ref={ref}
      popover="manual"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={`fixed inset-auto m-0 overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-xl shadow-black/20 outline-none ${width}`}
    >
      {children}
    </div>
  );
}

export function Menu({
  label,
  trigger = <MoreVertical size={17} />,
  buttonClass = ICON_BUTTON,
  align = "end",
  width = "w-56",
  children,
}: {
  label: string;
  /** What the button shows. */
  trigger?: ReactNode;
  buttonClass?: string;
  align?: "start" | "end";
  width?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={`${buttonClass} ${open ? "bg-ink/8 text-ink" : ""}`}
      >
        {trigger}
      </button>
      {open && (
        <Popup button={button} label={label} align={align} width={width} onClose={() => setOpen(false)}>
          {children(() => setOpen(false))}
        </Popup>
      )}
    </>
  );
}

export const MENU_ROW =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-ink/6 focus-visible:bg-ink/6 focus-visible:outline-none";

export function MenuItem({
  onSelect,
  danger = false,
  className = "",
  children,
}: {
  onSelect: () => void;
  danger?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`${MENU_ROW} ${danger ? "text-danger" : "text-ink [&>svg]:text-muted"} ${className}`}
    >
      {children}
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted">{children}</p>;
}

export function MenuDivider() {
  return <div className="mx-1 my-1 border-t border-line" />;
}
