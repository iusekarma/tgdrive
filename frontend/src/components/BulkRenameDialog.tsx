import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Copy, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api, type FileInfo } from "../api";
import { infoKey } from "../fileinfo";
import {
  cloneRules,
  DEFAULT_SETTINGS,
  loadPresets,
  loadSettings,
  needsInfo,
  newRule,
  plan,
  RULE_LABELS,
  ruleErrors,
  savePresets,
  saveSettings,
  TOKENS,
  type Order,
  type Planned,
  type Preset,
  type RenameItem,
  type Rule,
  type RuleType,
  type Settings,
  type Target,
} from "../rename";
import { Button, Dialog, DialogActions, ErrorNote, ICON_BUTTON, useSubmit } from "./ui";

export type Renamed = { id: string; from: string; to: string };

/** At most this many rows are drawn in the preview; every item is still checked and renamed. */
const PREVIEW_ROWS = 400;

const INPUT = "w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent";
const SMALL_BUTTON = "inline-flex rounded p-1 text-muted hover:bg-ink/5 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";

export function BulkRenameDialog({
  drive,
  items,
  others,
  onClose,
  onRenamed,
}: {
  drive: string;
  items: RenameItem[];
  /** Per folder, names of items there that aren't being renamed (when known). */
  others: Map<string | null, Set<string>>;
  onClose: () => void;
  onRenamed: (renamed: Renamed[]) => void;
}) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [show, setShow] = useState<"all" | "changes" | "problems">("all");
  const { busy, error, run } = useSubmit();
  useEffect(() => saveSettings(settings), [settings]);

  // Details (dates taken, sizes in pixels) only when a rule asks for them; they come from the database.
  const wantInfo = needsInfo(settings);
  const files = items.filter((i) => i.entry.kind === "file");
  const infos = useQueries({
    queries: files.map((i) => ({
      queryKey: infoKey(drive, i.entry.id),
      queryFn: () => api.fileInfo(drive, i.entry.id),
      enabled: wantInfo,
      staleTime: Infinity,
      retry: false,
    })),
  });
  const infoById = new Map<string, FileInfo | undefined>(files.map((f, i) => [f.entry.id, infos[i]?.data]));
  const infoLoading = wantInfo ? infos.filter((q) => q.isPending && q.fetchStatus !== "idle").length : 0;
  const infoSignature = wantInfo ? infos.map((q) => q.dataUpdatedAt).join(",") : "";

  const errors = ruleErrors(settings.rules);
  const planned = useMemo(
    () => plan(items.map((i) => ({ ...i, info: infoById.get(i.entry.id) })), settings, others),
    // infoById is rebuilt each render; its contents change only with infoSignature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, settings, others, infoSignature],
  );
  const changes = planned.filter((p) => p.changed);
  const problems = planned.filter((p) => p.problem);
  const shown = show === "changes" ? changes : show === "problems" ? problems : planned;
  const folders = new Set(items.map((i) => i.parent)).size;

  const setRules = (fn: (rules: Rule[]) => Rule[]) => setSettings((s) => ({ ...s, rules: fn(s.rules) }));
  const updateRule = (id: string, patch: Partial<Rule>) =>
    setRules((rules) => rules.map((r) => (r.id === id ? ({ ...r, ...patch } as Rule) : r)));
  const moveRule = (index: number, by: number) =>
    setRules((rules) => {
      const next = [...rules];
      const [r] = next.splice(index, 1);
      next.splice(index + by, 0, r);
      return next;
    });

  const blocked = changes.length === 0 || problems.length > 0 || errors.size > 0 || infoLoading > 0;

  function submit() {
    void run(async () => {
      await api.renameMany(
        drive,
        changes.map((p) => ({ id: p.entry.id, name: p.name })),
      );
      onRenamed(changes.map((p) => ({ id: p.entry.id, from: p.entry.name, to: p.name })));
    });
  }

  return (
    <Dialog title={`Rename ${items.length} ${items.length === 1 ? "item" : "items"}`} onClose={onClose} wide>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label="Rules" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">Rules, applied in order</h3>
            <AddRule onAdd={(type) => setRules((rules) => [...rules, newRule(type)])} />
            <button
              type="button"
              className={ICON_BUTTON}
              title="Start over"
              aria-label="Start over"
              onClick={() => setSettings({ ...DEFAULT_SETTINGS, rules: cloneRules(DEFAULT_SETTINGS.rules) })}
            >
              <RotateCcw size={16} />
            </button>
          </div>

          <ol className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
            {settings.rules.length === 0 && (
              <li className="rounded-md border border-dashed border-line p-3 text-sm text-muted">
                No rules: add one above.
              </li>
            )}
            {settings.rules.map((rule, i) => (
              <li key={rule.id} className={`rounded-lg border border-line bg-paper p-3 ${rule.on ? "" : "opacity-60"}`}>
                <div className="mb-2 flex items-center gap-1">
                  <label className="mr-auto flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" checked={rule.on} onChange={(e) => updateRule(rule.id, { on: e.target.checked })} />
                    <span>
                      {i + 1}. {RULE_LABELS[rule.type]}
                    </span>
                  </label>
                  <button type="button" className={SMALL_BUTTON} title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => moveRule(i, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className={SMALL_BUTTON}
                    title="Move down"
                    aria-label="Move down"
                    disabled={i === settings.rules.length - 1}
                    onClick={() => moveRule(i, 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    className={SMALL_BUTTON}
                    title="Duplicate"
                    aria-label="Duplicate"
                    onClick={() => setRules((rules) => [...rules.slice(0, i + 1), ...cloneRules([rule]), ...rules.slice(i + 1)])}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    type="button"
                    className={SMALL_BUTTON}
                    title="Remove"
                    aria-label="Remove"
                    onClick={() => setRules((rules) => rules.filter((r) => r.id !== rule.id))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <RuleFields rule={rule} update={(patch) => updateRule(rule.id, patch)} />
                {errors.get(rule.id) && <p className="mt-2 text-xs text-danger">{errors.get(rule.id)}</p>}
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="shrink-0">Number in order of</span>
              <select
                className={`${INPUT} w-auto min-w-0 shrink`}
                value={settings.order}
                onChange={(e) => setSettings((s) => ({ ...s, order: e.target.value as Order }))}
              >
                <option value="listed">the list</option>
                <option value="name">name</option>
                <option value="date">date taken or modified</option>
                <option value="created">upload date</option>
                <option value="size">size</option>
                <option value="kind">type</option>
              </select>
            </label>
            <Check label="Reverse" checked={settings.reverse} onChange={(reverse) => setSettings((s) => ({ ...s, reverse }))} />
            {folders > 1 && (
              <Check
                label="Restart in each folder"
                checked={settings.perFolder}
                onChange={(perFolder) => setSettings((s) => ({ ...s, perFolder }))}
              />
            )}
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-muted hover:text-ink">Pattern tokens</summary>
            <p className="mt-2 text-muted">
              Usable in a pattern, inserted text, and replacements. With regular expressions, replacements also take{" "}
              <code>$1</code>, <code>$&lt;name&gt;</code> and <code>$&amp;</code>.
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {TOKENS.map((t) => (
                <div key={t.token} className="contents">
                  <dt>
                    <code className="text-accent">{t.token}</code>
                  </dt>
                  <dd className="text-muted">{t.meaning}</dd>
                </div>
              ))}
            </dl>
          </details>

          <Presets settings={settings} onLoad={(s) => setSettings({ ...s, rules: cloneRules(s.rules) })} />
        </section>

        <section aria-label="Preview" className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <p className="mr-auto" aria-live="polite">
              <strong>{changes.length}</strong> of {planned.length} will change
              {problems.length > 0 && (
                <span className="text-danger">
                  {" "}
                  · {problems.length} {problems.length === 1 ? "problem" : "problems"}
                </span>
              )}
              {infoLoading > 0 && <span className="text-muted"> · reading details ({infoLoading} left)</span>}
            </p>
            <div role="group" aria-label="Show" className="flex rounded-md border border-line bg-paper p-0.5 text-xs">
              {(["all", "changes", "problems"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={show === v}
                  onClick={() => setShow(v)}
                  className={`rounded px-2 py-1 capitalize ${show === v ? "bg-ink/10 text-ink" : "text-muted hover:text-ink"}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto rounded-md border border-line bg-paper">
            {shown.length === 0 && <li className="p-3 text-sm text-muted">Nothing to show.</li>}
            {shown.slice(0, PREVIEW_ROWS).map((p) => (
              <PreviewRow key={p.entry.id} planned={p} />
            ))}
            {shown.length > PREVIEW_ROWS && (
              <li className="p-3 text-sm text-muted">…and {shown.length - PREVIEW_ROWS} more, renamed the same way.</li>
            )}
          </ul>
        </section>
      </div>

      <div className="mt-4">
        <ErrorNote>{error}</ErrorNote>
      </div>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || blocked} onClick={submit}>
          {busy ? "Renaming…" : changes.length ? `Rename ${changes.length}` : "Rename"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** The new name, with the part that differs from the old one marked. */
function PreviewRow({ planned: p }: { planned: Planned }) {
  const from = p.entry.name;
  const to = p.name;
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start += 1;
  let end = 0;
  while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end += 1;
  return (
    <li className={`px-3 py-2 text-sm ${p.problem ? "bg-danger/5" : ""}`}>
      <div className={`truncate ${p.changed ? "text-muted line-through decoration-muted/50" : "text-muted"}`} title={from}>
        {from}
      </div>
      {p.changed && (
        <div className="flex items-center gap-1.5">
          <ArrowRight size={13} className="shrink-0 text-muted" aria-hidden="true" />
          <span className="truncate font-medium" title={to}>
            {to.slice(0, start)}
            <mark className="rounded-sm bg-accent/20 text-ink">{to.slice(start, to.length - end)}</mark>
            {to.slice(to.length - end)}
          </span>
        </div>
      )}
      {p.problem && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-danger">
          <AlertTriangle size={12} aria-hidden="true" />
          {p.problem}
        </p>
      )}
    </li>
  );
}

function AddRule({ onAdd }: { onAdd: (type: RuleType) => void }) {
  return (
    <label className="relative inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1.5 text-sm font-medium hover:bg-ink/5">
      <Plus size={15} aria-hidden="true" />
      Add rule
      <select
        aria-label="Add rule"
        className="absolute inset-0 cursor-pointer opacity-0"
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value as RuleType);
        }}
      >
        <option value="" disabled>
          Add rule
        </option>
        {(Object.keys(RULE_LABELS) as RuleType[]).map((t) => (
          <option key={t} value={t}>
            {RULE_LABELS[t]}
          </option>
        ))}
      </select>
    </label>
  );
}

function Presets({ settings, onLoad }: { settings: Settings; onLoad: (settings: Settings) => void }) {
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [name, setName] = useState("");
  const change = (next: Preset[]) => {
    setPresets(next);
    savePresets(next);
  };
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted hover:text-ink">Presets{presets.length ? ` (${presets.length})` : ""}</summary>
      <ul className="mt-2 space-y-1">
        {presets.map((p) => (
          <li key={p.name} className="flex items-center gap-2">
            <button type="button" className="mr-auto truncate text-left text-accent hover:underline" onClick={() => onLoad(p.settings)}>
              {p.name}
            </button>
            <button
              type="button"
              className={SMALL_BUTTON}
              aria-label={`Delete preset ${p.name}`}
              title="Delete preset"
              onClick={() => change(presets.filter((x) => x !== p))}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          change([...presets.filter((p) => p.name !== trimmed), { name: trimmed, settings }]);
          setName("");
        }}
      >
        <input className={INPUT} placeholder="Save these rules as…" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="sm" disabled={!name.trim()}>
          Save
        </Button>
      </form>
    </details>
  );
}

// --- the fields of each rule ------------------------------------------------------

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">{children}</div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Text({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block min-w-0 flex-1 basis-40 text-xs text-muted">
      {label}
      <input
        className={`${INPUT} mt-1 ${mono ? "font-mono" : ""}`}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Num({ label, value, onChange, min }: { label: string; value: number; onChange: (value: number) => void; min?: number }) {
  return (
    <label className="flex items-center gap-1.5 text-sm">
      {label}
      <input
        type="number"
        className={`${INPUT} w-20`}
        value={value}
        min={min}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.trunc(n));
        }}
      />
    </label>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm">
      {label}
      <select className={`${INPUT} w-auto`} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

const TARGETS: [Target, string][] = [
  ["name", "Name"],
  ["ext", "Extension"],
  ["all", "Name and extension"],
];

function RuleFields({ rule, update }: { rule: Rule; update: (patch: Partial<Rule>) => void }) {
  const target = "target" in rule && (
    <Choice label="In" value={rule.target} options={TARGETS} onChange={(target) => update({ target })} />
  );
  switch (rule.type) {
    case "replace":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Text label="Find" value={rule.find} mono={rule.regex} placeholder={rule.regex ? "(\\d+)" : "text"} onChange={(find) => update({ find })} />
            <Text
              label="Replace with"
              value={rule.replace}
              mono={rule.regex}
              placeholder={rule.regex ? "$1" : "nothing: removes it"}
              onChange={(replace) => update({ replace })}
            />
          </div>
          <Row>
            <Check label="Regular expression" checked={rule.regex} onChange={(regex) => update({ regex })} />
            <Check label="Match case" checked={rule.matchCase} onChange={(matchCase) => update({ matchCase })} />
            <Check label="Whole words" checked={rule.wholeWord} onChange={(wholeWord) => update({ wholeWord })} />
            <Check label="Every match" checked={rule.every} onChange={(every) => update({ every })} />
            {target}
          </Row>
        </div>
      );
    case "template":
      return (
        <div className="space-y-1">
          <Text label="New name" value={rule.template} mono placeholder="{date:YYYY-MM-DD} {n:3}" onChange={(template) => update({ template })} />
          <p className="text-xs text-muted">The extension is kept unless the pattern uses {"{ext}"} or {"{full}"}.</p>
        </div>
      );
    case "insert":
      return (
        <div className="space-y-2">
          <Text label="Text" value={rule.text} placeholder="e.g. {parent} - " onChange={(text) => update({ text })} />
          <Row>
            <Choice
              label="At"
              value={rule.where}
              options={[
                ["start", "the start"],
                ["end", "the end"],
                ["at", "position"],
              ]}
              onChange={(where) => update({ where })}
            />
            {rule.where === "at" && (
              <>
                <Num label="" value={rule.at} min={0} onChange={(at) => update({ at })} />
                <Choice
                  value={rule.fromEnd ? "end" : "start"}
                  options={[
                    ["start", "from the start"],
                    ["end", "from the end"],
                  ]}
                  onChange={(v) => update({ fromEnd: v === "end" })}
                />
              </>
            )}
            {target}
          </Row>
        </div>
      );
    case "remove":
      return (
        <Row>
          <Choice
            value={rule.mode}
            options={[
              ["first", "First"],
              ["last", "Last"],
              ["range", "From character"],
            ]}
            onChange={(mode) => update({ mode })}
          />
          {rule.mode === "range" && <Num label="" value={rule.from} min={1} onChange={(from) => update({ from })} />}
          <Num label={rule.mode === "range" ? "remove" : ""} value={rule.count} min={0} onChange={(count) => update({ count })} />
          <span>{rule.count === 1 ? "character" : "characters"}</span>
          {target}
        </Row>
      );
    case "number":
      return (
        <div className="space-y-2">
          <Row>
            <Num label="Start at" value={rule.start} onChange={(start) => update({ start })} />
            <Num label="Step" value={rule.step} onChange={(step) => update({ step })} />
            <Choice
              label="Style"
              value={rule.style}
              options={[
                ["decimal", "1, 2, 3"],
                ["lower", "a, b, c"],
                ["upper", "A, B, C"],
                ["roman", "I, II, III"],
              ]}
              onChange={(style) => update({ style })}
            />
          </Row>
          <Row>
            {rule.style === "decimal" && (
              <Choice
                label="Digits"
                value={String(rule.pad)}
                options={[
                  ["-1", "Fit the largest"],
                  ["0", "As needed"],
                  ["2", "01"],
                  ["3", "001"],
                  ["4", "0001"],
                  ["5", "00001"],
                ]}
                onChange={(pad) => update({ pad: Number(pad) })}
              />
            )}
            <Choice
              label="Put it"
              value={rule.where}
              options={[
                ["start", "before the name"],
                ["end", "after the name"],
                ["replace", "instead of the name"],
              ]}
              onChange={(where) => update({ where })}
            />
            {rule.where !== "replace" && (
              <label className="flex items-center gap-1.5 text-sm">
                Separator
                <input
                  className={`${INPUT} w-16 font-mono`}
                  value={rule.separator}
                  onChange={(e) => update({ separator: e.target.value })}
                />
              </label>
            )}
          </Row>
        </div>
      );
    case "case":
      return (
        <Row>
          <Choice
            value={rule.mode}
            options={[
              ["title", "Title Case"],
              ["sentence", "Sentence case"],
              ["lower", "lowercase"],
              ["upper", "UPPERCASE"],
              ["swap", "sWAP cASE"],
              ["camel", "camelCase"],
              ["pascal", "PascalCase"],
              ["snake", "snake_case"],
              ["kebab", "kebab-case"],
            ]}
            onChange={(mode) => update({ mode })}
          />
          {target}
        </Row>
      );
    case "clean":
      return (
        <div className="space-y-2">
          <Row>
            <Check label="Trim spaces and separators at the ends" checked={rule.trim} onChange={(trim) => update({ trim })} />
            <Check label="Collapse repeated spaces" checked={rule.collapse} onChange={(collapse) => update({ collapse })} />
            <Check label="Underscores and dots to spaces" checked={rule.separators} onChange={(separators) => update({ separators })} />
            <Check label="Remove [brackets], (parentheses), {braces}" checked={rule.brackets} onChange={(brackets) => update({ brackets })} />
            <Check label="Remove accents (é → e)" checked={rule.accents} onChange={(accents) => update({ accents })} />
          </Row>
          <Row>
            <Choice
              label="Spaces"
              value={rule.spaces}
              options={[
                ["", "keep"],
                ["_", "to _"],
                ["-", "to -"],
                [".", "to ."],
              ]}
              onChange={(spaces) => update({ spaces })}
            />
            {target}
          </Row>
        </div>
      );
    case "extension":
      return (
        <Row>
          <Choice
            value={rule.mode}
            options={[
              ["lower", "Lowercase"],
              ["upper", "Uppercase"],
              ["set", "Change to"],
              ["remove", "Remove"],
            ]}
            onChange={(mode) => update({ mode })}
          />
          {rule.mode === "set" && (
            <input
              className={`${INPUT} w-28 font-mono`}
              placeholder="jpg"
              value={rule.value}
              onChange={(e) => update({ value: e.target.value })}
            />
          )}
          <span className="text-xs text-muted">Files only. Doesn't convert the file.</span>
        </Row>
      );
  }
}
