import type { Entry, FileInfo } from "./api";
import { formatSize } from "./format";

// Bulk renaming: an ordered list of rules, each turning the name the rule
// before it produced into a new one. Everything here is pure, so the dialog
// can re-run it on every keystroke for the preview.

/** Which part of the name a rule works on. Folders have no extension. */
export type Target = "name" | "ext" | "all";
export type CaseMode = "lower" | "upper" | "title" | "sentence" | "camel" | "pascal" | "snake" | "kebab" | "swap";
export type CounterStyle = "decimal" | "lower" | "upper" | "roman";

export type Rule = { id: string; on: boolean } & (
  | {
      type: "replace";
      find: string;
      replace: string;
      regex: boolean;
      matchCase: boolean;
      wholeWord: boolean;
      every: boolean;
      target: Target;
    }
  | { type: "template"; template: string }
  | { type: "insert"; text: string; where: "start" | "end" | "at"; at: number; fromEnd: boolean; target: Target }
  | { type: "remove"; mode: "first" | "last" | "range"; count: number; from: number; target: Target }
  | {
      type: "number";
      start: number;
      step: number;
      /** Digits to pad to; 0 for none, -1 to fit the largest number. */
      pad: number;
      style: CounterStyle;
      where: "start" | "end" | "replace";
      separator: string;
    }
  | { type: "case"; mode: CaseMode; target: Target }
  | {
      type: "clean";
      trim: boolean;
      collapse: boolean;
      separators: boolean;
      brackets: boolean;
      accents: boolean;
      spaces: "" | "_" | "-" | ".";
      target: Target;
    }
  | { type: "extension"; mode: "lower" | "upper" | "set" | "remove"; value: string }
);
export type RuleType = Rule["type"];

export type Order = "listed" | "name" | "created" | "date" | "size" | "kind";
export type Settings = {
  rules: Rule[];
  order: Order;
  reverse: boolean;
  /** Numbering starts again in each folder (matters for search results). */
  perFolder: boolean;
};

export type RenameItem = {
  entry: Entry;
  parent: string | null;
  /** The folder it is in, for {parent}. */
  parentName: string;
  info?: FileInfo;
};

export type Planned = {
  entry: Entry;
  parent: string | null;
  name: string;
  changed: boolean;
  problem: string | null;
};

export const RULE_LABELS: Record<RuleType, string> = {
  replace: "Find and replace",
  template: "New name from pattern",
  insert: "Insert text",
  remove: "Remove characters",
  number: "Number",
  case: "Change case",
  clean: "Clean up",
  extension: "Extension",
};

let nextId = 0;
const newId = () => `r${Date.now().toString(36)}${(nextId++).toString(36)}`;

export function newRule(type: RuleType): Rule {
  const base = { id: newId(), on: true };
  switch (type) {
    case "replace":
      return { ...base, type, find: "", replace: "", regex: false, matchCase: false, wholeWord: false, every: true, target: "name" };
    case "template":
      return { ...base, type, template: "{name}" };
    case "insert":
      return { ...base, type, text: "", where: "start", at: 0, fromEnd: false, target: "name" };
    case "remove":
      return { ...base, type, mode: "first", count: 1, from: 1, target: "name" };
    case "number":
      return { ...base, type, start: 1, step: 1, pad: -1, style: "decimal", where: "start", separator: " " };
    case "case":
      return { ...base, type, mode: "title", target: "name" };
    case "clean":
      return { ...base, type, trim: true, collapse: true, separators: false, brackets: false, accents: false, spaces: "", target: "name" };
    case "extension":
      return { ...base, type, mode: "lower", value: "" };
  }
}

/** A copy with fresh ids, for loading a saved preset next to rules already open. */
export const cloneRules = (rules: Rule[]): Rule[] => rules.map((r) => ({ ...r, id: newId() }));

export const DEFAULT_SETTINGS: Settings = {
  rules: [newRule("replace")],
  order: "listed",
  reverse: false,
  perFolder: false,
};

// --- names ------------------------------------------------------------------

type Parts = { stem: string; ext: string };

export function splitName(name: string, kind: Entry["kind"]): Parts {
  const dot = name.lastIndexOf(".");
  if (kind === "dir" || dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

const joinName = ({ stem, ext }: Parts) => (ext ? `${stem}.${ext}` : stem);

function onTarget(parts: Parts, target: Target, kind: Entry["kind"], fn: (s: string) => string): Parts {
  if (target === "name") return { ...parts, stem: fn(parts.stem) };
  if (target === "ext") return kind === "dir" ? parts : { ...parts, ext: fn(parts.ext) };
  return splitName(fn(joinName(parts)), kind);
}

/** Why the server would refuse a name, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return "Name is empty";
  if (name.includes("/")) return "Names can't contain a slash";
  if (name === "." || name === "..") return "Not allowed as a name";
  if (name.length > 255) return "Longer than 255 characters";
  return null;
}

// --- tokens -------------------------------------------------------------------

export const TOKENS: { token: string; meaning: string }[] = [
  { token: "{name}", meaning: "Original name, without extension" },
  { token: "{ext}", meaning: "Original extension, without the dot" },
  { token: "{full}", meaning: "Original name with extension" },
  { token: "{n}", meaning: "Counter: {n:3} pads to 3 digits, {n:3:10:5} starts at 10, steps by 5" },
  { token: "{count}", meaning: "How many items are being renamed" },
  { token: "{parent}", meaning: "Name of the folder it is in" },
  { token: "{date}", meaning: "Date taken, else last modified, else uploaded" },
  { token: "{taken}", meaning: "Date taken (photos)" },
  { token: "{modified}", meaning: "File's last-modified date" },
  { token: "{created}", meaning: "Upload date. Dates take a format: {date:YYYY-MM-DD HH.mm}" },
  { token: "{width} {height}", meaning: "Image or video size in pixels" },
  { token: "{duration}", meaning: "Length of audio or video, as 1h02m03s" },
  { token: "{camera}", meaning: "Camera model (photos)" },
  { token: "{size}", meaning: "File size, as 1.2 MB" },
  { token: "|upper |lower |title", meaning: "Change a token's case: {name|lower}" },
];

/** Tokens that need each file's details, which are fetched only when used. */
const INFO_TOKEN = /\{(date|taken|modified|width|height|duration|camera)\b/;

export function needsInfo(settings: Settings): boolean {
  if (settings.order === "date") return true;
  return settings.rules.some((r) => r.on && INFO_TOKEN.test(ruleText(r)));
}

function ruleText(r: Rule): string {
  if (r.type === "template") return r.template;
  if (r.type === "insert") return r.text;
  if (r.type === "replace") return r.replace;
  return "";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatStamp(date: Date, format: string): string {
  const parts: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: pad2(date.getMonth() + 1),
    DD: pad2(date.getDate()),
    HH: pad2(date.getHours()),
    mm: pad2(date.getMinutes()),
    ss: pad2(date.getSeconds()),
  };
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (m) => parts[m]);
}

/** "YYYY-MM-DD HH:MM:SS" in the camera's own time, read as local time so it prints as taken. */
function takenDate(taken?: string): Date | null {
  const m = taken?.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

const modifiedDate = (info?: FileInfo) => (info?.modified ? new Date(info.modified * 1000) : null);

function bestDate(item: RenameItem): Date {
  return takenDate(item.info?.taken) ?? modifiedDate(item.info) ?? new Date(item.entry.created_at * 1000);
}

function durationText(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${pad2(m)}m${pad2(s % 60)}s` : `${m}m${pad2(s % 60)}s`;
}

export function counter(value: number, style: CounterStyle, pad: number): string {
  let text: string;
  if (style === "roman") text = roman(value);
  else if (style === "lower" || style === "upper") {
    text = letters(value);
    if (style === "upper") text = text.toUpperCase();
  } else {
    const digits = String(Math.abs(value)).padStart(Math.max(pad, 0), "0");
    text = value < 0 ? `-${digits}` : digits;
  }
  return text;
}

/** 1 → a, 26 → z, 27 → aa, as spreadsheets name columns. */
function letters(n: number): string {
  if (n < 1) return String(n);
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function roman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const table: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

type Context = {
  item: RenameItem;
  original: Parts;
  /** 0-based position in numbering order (within its folder, if numbering restarts). */
  index: number;
  /** Items numbered alongside this one. */
  group: number;
  count: number;
};

function expand(text: string, ctx: Context): string {
  return text.replace(/\{([a-z]+)(?::([^}|]*))?((?:\|[a-z]+)*)\}/g, (whole, key: string, arg: string | undefined, pipes: string) => {
    let value = tokenValue(key, arg, ctx);
    if (value === null) return whole;
    for (const pipe of pipes.split("|").slice(1)) {
      if (pipe === "upper") value = value.toUpperCase();
      else if (pipe === "lower") value = value.toLowerCase();
      else if (pipe === "title") value = changeCase(value, "title");
    }
    return value;
  });
}

function tokenValue(key: string, arg: string | undefined, ctx: Context): string | null {
  const { item, original } = ctx;
  const info = item.info;
  const dateFormat = arg || "YYYY-MM-DD";
  switch (key) {
    case "name":
      return original.stem;
    case "ext":
      return original.ext;
    case "full":
      return item.entry.name;
    case "n": {
      const [pad = "", start = "1", step = "1"] = (arg ?? "").split(":");
      const value = (Number(start) || 0) + ctx.index * (step === "" ? 1 : Number(step) || 0);
      const digits = pad === "" ? 0 : Number(pad) || 0;
      return counter(value, "decimal", digits);
    }
    case "count":
      return String(ctx.count);
    case "parent":
      return item.parentName;
    case "date":
      return formatStamp(bestDate(item), dateFormat);
    case "taken": {
      const d = takenDate(info?.taken);
      return d ? formatStamp(d, dateFormat) : "";
    }
    case "modified": {
      const d = modifiedDate(info);
      return d ? formatStamp(d, dateFormat) : "";
    }
    case "created":
      return formatStamp(new Date(item.entry.created_at * 1000), dateFormat);
    case "width":
      return info?.width ? String(info.width) : "";
    case "height":
      return info?.height ? String(info.height) : "";
    case "duration":
      return info?.duration ? durationText(info.duration) : "";
    case "camera":
      return info?.camera ?? "";
    case "size":
      return item.entry.kind === "file" ? formatSize(item.entry.size) : "";
    default:
      return null; // not a token: left as typed
  }
}

// --- rules --------------------------------------------------------------------

function words(text: string): string[] {
  return text
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

const capitalise = (w: string) => w.charAt(0).toLocaleUpperCase() + w.slice(1).toLocaleLowerCase();

export function changeCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "lower":
      return text.toLocaleLowerCase();
    case "upper":
      return text.toLocaleUpperCase();
    case "title":
      // Keeps the separators as they are; only letters at the start of words change.
      return text.toLocaleLowerCase().replace(/(^|[\s_\-.([{])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase());
    case "sentence": {
      const lower = text.toLocaleLowerCase();
      return lower.replace(/\p{L}/u, (ch) => ch.toLocaleUpperCase());
    }
    case "swap":
      return Array.from(text, (ch) => (ch === ch.toLocaleUpperCase() ? ch.toLocaleLowerCase() : ch.toLocaleUpperCase())).join("");
    case "camel": {
      const [first = "", ...rest] = words(text);
      return first.toLocaleLowerCase() + rest.map(capitalise).join("");
    }
    case "pascal":
      return words(text).map(capitalise).join("");
    case "snake":
      return words(text).map((w) => w.toLocaleLowerCase()).join("_");
    case "kebab":
      return words(text).map((w) => w.toLocaleLowerCase()).join("-");
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The rule's pattern, or the reason it isn't one. */
export function replacePattern(rule: Extract<Rule, { type: "replace" }>): RegExp | string | null {
  if (!rule.find) return null;
  let source = rule.regex ? rule.find : escapeRegex(rule.find);
  if (rule.wholeWord) source = `(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`;
  const flags = `${rule.every ? "g" : ""}${rule.matchCase ? "" : "i"}`;
  // Unicode mode reads \p{L} and astral characters, but refuses loose escapes like \- that people type;
  // so it is tried first and dropped if the pattern only works without it.
  try {
    return new RegExp(source, `${flags}u`);
  } catch (e) {
    if (!rule.wholeWord) {
      try {
        return new RegExp(source, flags);
      } catch {
        /* report the Unicode-mode error below */
      }
    }
    return e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : "Invalid pattern";
  }
}

/** Problems with the rules themselves, by rule id. */
export function ruleErrors(rules: Rule[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const r of rules) {
    if (!r.on) continue;
    if (r.type === "replace") {
      const pattern = replacePattern(r);
      if (typeof pattern === "string") errors.set(r.id, pattern);
    }
  }
  return errors;
}

/** $1, $<name>, $& and $$ in a replacement, done by hand so token values are never read as them. */
function substitute(replacement: string, match: RegExpExecArray | string[], groups?: Record<string, string>): string {
  return replacement.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (whole, what: string, name?: string) => {
    if (what === "$") return "$";
    if (what === "&") return match[0];
    if (name !== undefined) return groups?.[name] ?? "";
    const i = Number(what);
    return i < match.length ? (match[i] ?? "") : whole;
  });
}

function applyRule(rule: Rule, parts: Parts, ctx: Context): Parts {
  const kind = ctx.item.entry.kind;
  switch (rule.type) {
    case "replace": {
      const pattern = replacePattern(rule);
      if (!(pattern instanceof RegExp)) return parts;
      const replacement = expand(rule.replace, ctx);
      return onTarget(parts, rule.target, kind, (s) =>
        s.replace(pattern, (...args) => {
          if (!rule.regex) return replacement;
          const last = args[args.length - 1];
          const groups = typeof last === "object" && last !== null ? (last as Record<string, string>) : undefined;
          const captures = args.slice(0, groups ? -3 : -2) as string[];
          return substitute(replacement, captures, groups);
        }),
      );
    }
    case "template": {
      const name = expand(rule.template, ctx);
      // The extension stays unless the pattern places it itself with {ext} or {full}.
      return kind === "file" && parts.ext && !/\{ext\b|\{full\b/.test(rule.template)
        ? { stem: name, ext: parts.ext }
        : splitName(name, kind);
    }
    case "insert": {
      const text = expand(rule.text, ctx);
      return onTarget(parts, rule.target, kind, (s) => {
        if (rule.where === "start") return text + s;
        if (rule.where === "end") return s + text;
        const at = Math.min(Math.max(rule.at, 0), s.length);
        const i = rule.fromEnd ? s.length - at : at;
        return s.slice(0, i) + text + s.slice(i);
      });
    }
    case "remove":
      return onTarget(parts, rule.target, kind, (s) => {
        const chars = Array.from(s);
        const n = Math.max(rule.count, 0);
        if (rule.mode === "first") return chars.slice(n).join("");
        if (rule.mode === "last") return chars.slice(0, Math.max(chars.length - n, 0)).join("");
        const from = Math.max(rule.from, 1) - 1;
        return [...chars.slice(0, from), ...chars.slice(from + n)].join("");
      });
    case "number": {
      const value = rule.start + ctx.index * rule.step;
      const largest = Math.max(Math.abs(rule.start), Math.abs(rule.start + (ctx.group - 1) * rule.step));
      const pad = rule.pad < 0 ? String(largest).length : rule.pad;
      const n = counter(value, rule.style, pad);
      if (rule.where === "replace") return { ...parts, stem: n };
      return { ...parts, stem: rule.where === "start" ? n + rule.separator + parts.stem : parts.stem + rule.separator + n };
    }
    case "case":
      return onTarget(parts, rule.target, kind, (s) => changeCase(s, rule.mode));
    case "clean":
      return onTarget(parts, rule.target, kind, (s) => {
        let out = s;
        if (rule.accents) out = out.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
        if (rule.brackets) out = out.replace(/\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\s*/g, " ");
        if (rule.separators) out = out.replace(/[_.]+/g, " ");
        if (rule.collapse) out = out.replace(/\s+/g, " ");
        if (rule.trim) out = out.trim().replace(/^[\s_\-.]+|[\s_\-.]+$/g, "");
        if (rule.spaces) out = out.replace(/\s/g, rule.spaces);
        return out;
      });
    case "extension": {
      if (kind === "dir") return parts;
      if (rule.mode === "lower") return { ...parts, ext: parts.ext.toLocaleLowerCase() };
      if (rule.mode === "upper") return { ...parts, ext: parts.ext.toLocaleUpperCase() };
      if (rule.mode === "remove") return { ...parts, ext: "" };
      return { ...parts, ext: rule.value.replace(/^\.+/, "").trim() };
    }
  }
}

// --- ordering -------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: RenameItem, b: RenameItem, order: Order): number {
  switch (order) {
    case "name":
      return collator.compare(a.entry.name, b.entry.name);
    case "created":
      return a.entry.created_at - b.entry.created_at;
    case "date":
      return bestDate(a).getTime() - bestDate(b).getTime();
    case "size":
      return a.entry.size - b.entry.size;
    case "kind": {
      const ka = splitName(a.entry.name, a.entry.kind).ext.toLowerCase();
      const kb = splitName(b.entry.name, b.entry.kind).ext.toLowerCase();
      return (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "dir" ? -1 : 1) || collator.compare(ka, kb);
    }
    case "listed":
      return 0;
  }
}

/** The items in numbering order. Ties keep the order they are listed in. */
export function sortItems(items: RenameItem[], order: Order, reverse: boolean): RenameItem[] {
  const sorted = items.map((item, i) => ({ item, i }));
  const byName = (a: RenameItem, b: RenameItem) => (order === "listed" ? 0 : collator.compare(a.entry.name, b.entry.name));
  sorted.sort((a, b) => compare(a.item, b.item, order) || byName(a.item, b.item) || a.i - b.i);
  if (reverse) sorted.reverse();
  return sorted.map((s) => s.item);
}

// --- the whole plan -----------------------------------------------------------------

/**
 * New names for every item, in numbering order, with what would stop each one.
 * `others` holds, per folder, the names of items there that aren't being renamed
 * (when known; the server checks again either way).
 */
export function plan(items: RenameItem[], settings: Settings, others: Map<string | null, Set<string>>): Planned[] {
  const ordered = sortItems(items, settings.order, settings.reverse);
  const rules = settings.rules.filter((r) => r.on);
  const groupSizes = new Map<string | null, number>();
  for (const item of ordered) groupSizes.set(item.parent, (groupSizes.get(item.parent) ?? 0) + 1);
  const seen = new Map<string | null, number>();

  const out = ordered.map((item, i) => {
    let index = i;
    let group = ordered.length;
    if (settings.perFolder) {
      index = seen.get(item.parent) ?? 0;
      seen.set(item.parent, index + 1);
      group = groupSizes.get(item.parent) ?? 1;
    }
    const original = splitName(item.entry.name, item.entry.kind);
    const ctx: Context = { item, original, index, group, count: ordered.length };
    const name = joinName(rules.reduce((parts, rule) => applyRule(rule, parts, ctx), original));
    return { entry: item.entry, parent: item.parent, name, changed: name !== item.entry.name, problem: nameProblem(name) };
  });

  // The final names in each folder, to find two items landing on one name.
  const finals = new Map<string, number>();
  const key = (parent: string | null, name: string) => `${parent ?? ""}/${name}`;
  for (const p of out) finals.set(key(p.parent, p.name), (finals.get(key(p.parent, p.name)) ?? 0) + 1);
  for (const p of out) {
    if (p.problem) continue;
    if ((finals.get(key(p.parent, p.name)) ?? 0) > 1) p.problem = "Another item gets this name";
    else if (p.changed && others.get(p.parent)?.has(p.name)) p.problem = "Already taken in this folder";
  }
  return out;
}

// --- remembered settings -------------------------------------------------------------

const SAVED = "tgdrive.bulkRename";
const PRESETS = "tgdrive.bulkRename.presets";

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: just not remembered */
  }
}

/** Rules saved by an older version may lack newer fields: fill them from the defaults. */
function upgrade(rules: unknown): Rule[] | null {
  if (!Array.isArray(rules)) return null;
  const known = Object.keys(RULE_LABELS);
  return rules
    .filter((r): r is Rule => !!r && typeof r === "object" && known.includes((r as Rule).type))
    .map((r) => ({ ...newRule(r.type), ...r }) as Rule);
}

export function loadSettings(): Settings {
  const saved = read<Partial<Settings>>(SAVED);
  const rules = upgrade(saved?.rules);
  return { ...DEFAULT_SETTINGS, ...saved, rules: rules?.length ? rules : DEFAULT_SETTINGS.rules };
}

export const saveSettings = (settings: Settings) => write(SAVED, settings);

export type Preset = { name: string; settings: Settings };

export function loadPresets(): Preset[] {
  const presets = read<Preset[]>(PRESETS);
  if (!Array.isArray(presets)) return [];
  return presets.flatMap((p) => {
    const rules = upgrade(p?.settings?.rules);
    return typeof p?.name === "string" && rules ? [{ name: p.name, settings: { ...DEFAULT_SETTINGS, ...p.settings, rules } }] : [];
  });
}

export const savePresets = (presets: Preset[]) => write(PRESETS, presets);
