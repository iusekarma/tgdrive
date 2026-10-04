import { LayoutGrid, List, MoreHorizontal, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";

type Variant = "primary" | "quiet" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-teal text-teal-ink hover:brightness-110",
  quiet: "border border-line bg-surface text-ink hover:bg-ink/5",
  danger: "bg-danger text-danger-ink hover:brightness-110",
};

export function Button({
  variant = "quiet",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export const ICON_BUTTON = "inline-flex rounded-md p-2 text-muted hover:bg-ink/5 hover:text-ink";

export function Field({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-muted focus:border-teal"
      />
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function Dialog({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] rounded-xl border border-line bg-paper p-0 text-ink shadow-2xl backdrop:bg-black/50 ${wide ? "max-w-4xl" : "max-w-md"}`}
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-5">
        <h2 className="min-w-0 break-words text-xl font-semibold tracking-tight">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className={`${ICON_BUTTON} -mr-2 -mt-1 shrink-0`}>
          <X size={18} />
        </button>
      </div>
      <div className="px-6 pb-6 pt-4">{children}</div>
    </dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-2">{children}</div>;
}

export function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={ICON_BUTTON}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-line bg-surface py-1 shadow-lg"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onSelect,
  danger = false,
  children,
}: {
  onSelect: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-ink/5 ${danger ? "text-danger" : "text-ink"}`}
    >
      {children}
    </button>
  );
}

/** `wide` spans the whole window, for pages with a sidebar. */
export function PageHeader({ wide = false, children }: { wide?: boolean; children?: ReactNode }) {
  return (
    <header className="border-b border-line">
      <div className={`mx-auto flex items-center justify-between gap-4 px-5 py-3 ${wide ? "" : "max-w-4xl"}`}>
        <Link to="/" className="text-lg font-semibold tracking-tight">
          tgdrive
        </Link>
        <div className="flex items-center gap-2">{children}</div>
      </div>
    </header>
  );
}

export type View = "list" | "grid";

/** A list-or-grid choice, remembered in this browser under `key`. */
export function useSavedView(key: string): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(key) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  function change(next: View) {
    setView(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }
  return [view, change];
}

export function ViewToggle({
  view,
  onChange,
  className = "",
}: {
  view: View;
  onChange: (view: View) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="View" className={`flex rounded-md border border-line bg-surface p-0.5 ${className}`}>
      {(["list", "grid"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          aria-label={v === "list" ? "List view" : "Grid view"}
          title={v === "list" ? "List view" : "Grid view"}
          onClick={() => onChange(v)}
          className={`rounded p-1.5 ${view === v ? "bg-teal text-teal-ink" : "text-muted hover:text-ink"}`}
        >
          {v === "list" ? <List size={16} /> : <LayoutGrid size={16} />}
        </button>
      ))}
    </div>
  );
}

/** Tracks one in-flight action: disables the form and surfaces its error. */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
