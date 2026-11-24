import { LayoutGrid, List, X, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

type Variant = "primary" | "quiet" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-paper hover:bg-ink/85",
  quiet: "border border-line bg-surface text-ink hover:border-ink/25 hover:bg-ink/4",
  danger: "bg-danger text-danger-ink hover:brightness-110",
};

const SIZES = { md: "h-9 gap-2 px-3.5 text-sm", sm: "h-8 gap-1.5 px-2.5 text-[13px]" } as const;

export function Button({
  variant = "quiet",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZES }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    />
  );
}

export const ICON_BUTTON = 
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-ink/6 hover:text-ink";

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
        // React focuses on mount, before Dialog opens; Dialog looks for this to focus it again.
        data-autofocus={rest.autoFocus || undefined}
        className="h-10 w-full rounded-lg border border-line bg-paper px-3 text-base text-ink placeholder:text-muted hover:border-ink/25 focus:border-accent sm:text-sm"
      />
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
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
    if (el && !el.open) {
      el.showModal();
      // showModal() focuses the first focusable element (the close button), not the field asked for.
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
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
      className={`m-auto w-[calc(100%-2rem)] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl shadow-black/30 backdrop:bg-black/55 ${wide ? "max-w-5xl" : "max-w-md"}`}
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 bg-surface px-5 pb-3 pt-4">
        <h2 className="min-w-0 break-words text-base font-semibold leading-8">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className={`${ICON_BUTTON} -mr-1.5`}>
          <X size={18} />
        </button>
      </div>
      <div className="px-5 pb-5">{children}</div>
    </dialog>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-2">{children}</div>;
}

export type View = "list" | "grid";

/** A list-or-grid choice, remembered in this browser under `key`. */
export function useSavedView(key: string, initial: View = "list"): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === "grid" || saved === "list" ? saved : initial;
    } catch {
      return initial;
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
}: {
  view: View;
  onChange: (view: View) => void;
}) {
  return (
    <Segmented
      label="View"
      value={view}
      onChange={onChange}
      options={[
        { value: "list", label: "List view", Icon: List },
        { value: "grid", label: "Grid view", Icon: LayoutGrid },
      ]}
    />
  );
}

/** A few choices side by side, one of them on. With an icon, the label is its tooltip. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  value: T;
  options: { value: T; label: string; Icon?: LucideIcon }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`flex shrink-0 rounded-lg border border-line p-[3px] ${className}`}>
      {options.map(({ value: v, label: text, Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          aria-label={Icon ? text : undefined}
          title={Icon ? text : undefined}
          onClick={() => onChange(v)}
          className={`inline-flex h-6 flex-1 items-center justify-center rounded-[5px] text-[13px] transition-colors ${Icon ? "min-w-7 px-1" : "px-2.5"} ${value === v ? "bg-ink/10 text-ink" : "text-muted hover:text-ink"}`}
        >
          {Icon ? <Icon size={15} aria-hidden="true" /> : text}
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
