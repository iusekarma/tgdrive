/** Subtitle text, whatever it came in (SubRip, WebVTT, ASS, MP4 timed text), as cues to draw. */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface Cue {
  start: number;
  end: number;
  runs: Run[];
  /** As on a numeric keypad: 2 is bottom centre, 8 top centre. */
  align: number;
  /** Where the anchor goes, as fractions of the picture, if the subtitle says. */
  at?: { x: number; y: number };
}

/** What an embedded track needs to know to read its own packets. */
export interface AssStyle {
  align: number;
  bold: boolean;
  italic: boolean;
}

export interface AssHeader {
  width: number;
  height: number;
  styles: Map<string, AssStyle>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "‎", rlm: "‏", quot: '"' };

/** SubRip and WebVTT: <b> and <i> are kept, other tags dropped. */
export function tagged(text: string): { runs: Run[]; align?: number } {
  const runs: Run[] = [];
  let bold = 0;
  let italic = 0;
  let align: number | undefined;
  const clean = text.replace(/\{\\an?(\d)[^}]*\}/g, (_, n: string) => {
    align = Number(n);
    return "";
  });
  for (const part of clean.split(/(<[^>\n]*>)/)) {
    const tag = /^<(\/?)([a-z]*)[^>]*>$/i.exec(part);
    if (tag) {
      const by = tag[1] ? -1 : 1;
      if (tag[2].toLowerCase() === "b") bold = Math.max(0, bold + by);
      else if (tag[2].toLowerCase() === "i") italic = Math.max(0, italic + by);
      if (/^(b|i|u|s|c|v|font|lang|ruby|rt|)$/i.test(tag[2])) continue;
    }
    const plain = part.replace(/&([a-z]+);/g, (all, name: string) => ENTITIES[name] ?? all);
    if (plain) runs.push({ text: plain, bold: bold > 0, italic: italic > 0 });
  }
  return { runs, align };
}

export function plainCue(start: number, end: number, text: string): Cue | null {
  const { runs, align } = tagged(text.replace(/\r/g, "").trim());
  return runs.some((r) => r.text.trim()) ? { start, end, runs, align: align ?? 2 } : null;
}

// --- ASS ---------------------------------------------------------------------

export function assHeader(text: string): AssHeader {
  const header: AssHeader = { width: 384, height: 288, styles: new Map() };
  let format: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [, key, value] = /^(\w[\w ]*):\s*(.*)$/.exec(line) ?? [];
    if (!key) continue;
    if (key === "PlayResX") header.width = Number(value) || header.width;
    else if (key === "PlayResY") header.height = Number(value) || header.height;
    else if (key === "Format" && value.includes("Fontname")) format = value.split(",").map((f) => f.trim());
    else if (key === "Style" && format.length) {
      const fields = value.split(",");
      const of = (name: string) => fields[format.indexOf(name)]?.trim() ?? "";
      header.styles.set(of("Name"), {
        align: Number(of("Alignment")) || 2,
        bold: of("Bold") !== "0" && of("Bold") !== "",
        italic: of("Italic") !== "0" && of("Italic") !== "",
      });
    }
  }
  return header;
}

/** Style tags Cue can show are followed, the rest (colours, karaoke, drawings) are dropped. */
export function assCue(start: number, end: number, style: string, text: string, header: AssHeader): Cue | null {
  const base = header.styles.get(style.replace(/^\*/, "")) ?? { align: 2, bold: false, italic: false };
  let { align, bold, italic } = base;
  let at: Cue["at"];
  let drawing = false;
  const runs: Run[] = [];
  for (const part of text.split(/(\{[^}]*\})/)) {
    if (!part.startsWith("{") || !part.endsWith("}")) {
      if (!part || drawing) continue;
      runs.push({ text: part.replace(/\\N/g, "\n").replace(/\\n/g, " ").replace(/\\h/g, " "), bold, italic });
      continue;
    }
    for (const tag of part.slice(1, -1).split("\\").slice(1)) {
      const on = /^([bi])(\d+)$/.exec(tag);
      const pos = /^(?:pos|move)\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(tag);
      if (on?.[1] === "b") bold = on[2] !== "0";
      else if (on?.[1] === "i") italic = on[2] !== "0";
      else if (pos) at = { x: Number(pos[1]) / header.width, y: Number(pos[2]) / header.height };
      else if (/^an[1-9]/.test(tag)) align = Number(tag[2]);
      else if (/^p\d/.test(tag)) drawing = tag[1] !== "0";
      else if (/^r/.test(tag)) ({ bold, italic } = header.styles.get(tag.slice(1)) ?? base);
    }
  }
  return runs.some((r) => r.text.trim()) ? { start, end, runs, align, at } : null;
}

function parseAss(text: string): Cue[] {
  const header = assHeader(text);
  const cues: Cue[] = [];
  let format = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
  for (const line of text.split(/\r?\n/)) {
    if (/^Format:/.test(line) && /\bText\s*$/.test(line)) format = line.slice(7).split(",").map((f) => f.trim());
    if (!line.startsWith("Dialogue:")) continue;
    const fields = line.slice(9).split(",");
    const of = (name: string) => (fields[format.indexOf(name)] ?? "").trim();
    // Only the last field, the text, may contain commas.
    const body = fields.slice(format.length - 1).join(",");
    const cue = assCue(clock(of("Start")), clock(of("End")), of("Style"), body, header);
    if (cue) cues.push(cue);
  }
  return cues;
}

// --- whole files -------------------------------------------------------------

/** "1:02:03,456" or "02:03.456". */
function clock(text: string): number {
  return text.trim().replace(",", ".").split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function parseBlocks(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.split(/\n[ \t]*\n+/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const m = /([\d:.,]+)\s*-->\s*([\d:.,]+)(.*)/.exec(lines[at]);
    const cue = m && plainCue(clock(m[1]), clock(m[2]), lines.slice(at + 1).join("\n"));
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)) continue;
    // WebVTT: near the top of the picture.
    const line = /\bline:(-?[\d.]+)(%?)/.exec(m[3]);
    if (line && (line[2] ? Number(line[1]) < 40 : Number(line[1]) >= 0 && Number(line[1]) < 6)) cue.align = 8;
    cues.push(cue);
  }
  return cues;
}

export function parseSubtitles(name: string, data: ArrayBuffer): Cue[] {
  const text = decode(data).replace(/\r\n?/g, "\n");
  const cues = /\.(ass|ssa)$/i.test(name) ? parseAss(text) : parseBlocks(text);
  return cues.sort((a, b) => a.start - b.start);
}

/** Subtitle files come in whatever encoding their maker's computer used. */
function decode(data: ArrayBuffer): string {
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

const stem = (name: string) => name.slice(0, Math.max(0, name.lastIndexOf(".")) || undefined);

export const isSubtitleFile = (name: string) => /\.(srt|vtt|ass|ssa)$/i.test(name);

/** "Film.en.srt" next to "Film.mkv" is its "en"; "Film.srt" is its own. Null: not this video's. */
export function sidecarTag(video: string, file: string): string | null {
  if (!isSubtitleFile(file)) return null;
  const base = stem(video).toLowerCase();
  const own = stem(file);
  if (own.toLowerCase() === base) return "";
  return own.toLowerCase().startsWith(`${base}.`) ? own.slice(base.length + 1) : null;
}

/** "English" for "en" or "eng"; null for what isn't a language, or isn't known. */
export function languageName(code: string | undefined): string | null {
  if (!code || /^(und|mis|zxx|mul|root)$/i.test(code)) return null;
  try {
    const name = new Intl.DisplayNames(undefined, { type: "language", fallback: "none" }).of(code);
    return name ?? null;
  } catch {
    return null;
  }
}

/** So "eng", "en" and "en-US" compare equal. */
export function languageKey(code: string | undefined): string | null {
  if (!languageName(code)) return null;
  try {
    return new Intl.Locale(code!).language;
  } catch {
    return null;
  }
}
