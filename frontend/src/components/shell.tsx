import { Menu as MenuIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { useSavedFlag } from "../saved";
import { MasterPasswordDialog } from "./driveDialogs";
import Sidebar from "./Sidebar";
import { ICON_BUTTON } from "./ui";

const OpenDrawer = createContext<() => void>(() => undefined);

/** The sidebar on narrow screens, over the page. A modal dialog, so the page behind is out of reach. */
function Drawer({ onClose, onMasterPassword }: { onClose: () => void; onMasterPassword: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label="Navigation"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-0 h-dvh max-h-none w-72 max-w-[85vw] border-r border-line bg-shell p-0 text-ink shadow-2xl backdrop:bg-black/55"
    >
      <Sidebar onClose={onClose} onMasterPassword={onMasterPassword} />
    </dialog>
  );
}

/**
 * Around every page: the sidebar, and the panel the page is drawn in. On wide
 * screens the panel scrolls inside the window, so the sidebar stays put;
 * on narrow ones the window scrolls and the sidebar is a drawer.
 */
export default function Shell() {
  const [rail, setRail] = useSavedFlag("tgdrive.rail");
  const [drawer, setDrawer] = useState(false);
  const [masterPassword, setMasterPassword] = useState(false);
  const location = useLocation();
  useEffect(() => setDrawer(false), [location.key]);

  return (
    <OpenDrawer.Provider value={() => setDrawer(true)}>
      <div className="lg:flex lg:h-dvh lg:overflow-hidden">
        <aside className={`hidden shrink-0 transition-[width] duration-200 lg:block ${rail ? "w-[60px]" : "w-64"}`}>
          <Sidebar rail={rail} onToggleRail={() => setRail(!rail)} onMasterPassword={() => setMasterPassword(true)} />
        </aside>
        <div className="relative flex min-h-dvh min-w-0 flex-1 bg-paper lg:my-2 lg:mr-2 lg:min-h-0 lg:overflow-hidden lg:rounded-2xl lg:border lg:border-line">
          <Outlet />
        </div>
      </div>
      {drawer && (
        <Drawer
          onClose={() => setDrawer(false)}
          onMasterPassword={() => {
            setDrawer(false);
            setMasterPassword(true);
          }}
        />
      )}
      {masterPassword && <MasterPasswordDialog onClose={() => setMasterPassword(false)} />}
    </OpenDrawer.Provider>
  );
}

/**
 * The scrolling part of the panel. Everything in it is laid out by the width
 * it actually has (container queries: `@2xl:` and so on), not the window's:
 * the sidebar and the details panel take their share of that.
 */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div data-scroller className="@container flex min-w-0 flex-1 flex-col lg:overflow-y-auto">
      {children}
    </div>
  );
}

/** Back to the top, as when another folder opens. */
export function scrollToTop() {
  document.querySelector("[data-scroller]")?.scrollTo(0, 0);
  window.scrollTo(0, 0);
}

/** Sticks to the top of the page. One row, whatever is in it: 56px tall. */
export function Topbar({ children }: { children: ReactNode }) {
  const openDrawer = useContext(OpenDrawer);
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1.5 border-b border-line bg-paper px-3 @3xl:px-6">
      <button type="button" onClick={openDrawer} aria-label="Open navigation" className={`${ICON_BUTTON} lg:hidden`}>
        <MenuIcon size={19} aria-hidden="true" />
      </button>
      {children}
    </header>
  );
}

/**
 * Floats over the foot of the page: what's selected, what's running, what just
 * happened. It takes no room, so nothing moves when it comes and goes. Its height
 * is shared as --dock, for the uploads panel to sit above it.
 */
export function Dock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const height = el.offsetHeight;
      root.style.setProperty("--dock", height ? `${height + 8}px` : "0px");
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--dock");
    };
  }, []);
  return (
    <div className="pointer-events-none sticky bottom-0 z-20 mt-auto h-0 shrink-0">
      <div
        ref={ref}
        className="absolute inset-x-3 bottom-3 flex flex-col items-center gap-2 *:pointer-events-auto *:animate-rise @3xl:bottom-5"
      >
        {children}
      </div>
    </div>
  );
}

/** One message in the dock. */
export function Toast({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex max-w-full items-center gap-3 rounded-xl border border-line bg-surface py-1.5 pl-4 pr-1.5 text-sm shadow-xl shadow-black/20"
    >
      {children}
    </div>
  );
}
