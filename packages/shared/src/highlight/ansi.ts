import type { ResolvedSyntaxTheme } from "./themes.ts";

/** SGR attributes carried from one line to the next. */
export interface AnsiState {
  readonly fg?: string | undefined;
  readonly bg?: string | undefined;
  /** italic 1, bold 2, underline 4, strikethrough 8, inverse 16. */
  readonly bits: number;
}

export interface AnsiRun {
  readonly content: string;
  /** Offset of the run's first character in the line, counting escape sequences. */
  readonly offset: number;
  readonly color?: string;
  readonly bgColor?: string;
  readonly fontStyle: number;
}

export const ANSI_RESET: AnsiState = { bits: 0 };

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function color256(index: number, theme: ResolvedSyntaxTheme): string | undefined {
  if (index < 16) return theme.ansi[index];
  if (index < 232) {
    const n = index - 16;
    const level = (v: number) => (v === 0 ? 0 : v * 40 + 55);
    return `#${hex(level(Math.floor(n / 36)))}${hex(level(Math.floor(n / 6) % 6))}${hex(level(n % 6))}`;
  }
  if (index < 256) {
    const gray = (index - 232) * 10 + 8;
    return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
  }
  return undefined;
}

function applySgr(state: AnsiState, params: number[], theme: ResolvedSyntaxTheme): AnsiState {
  let { fg, bg, bits } = state;
  if (params.length === 0) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      fg = undefined;
      bg = undefined;
      bits = 0;
    } else if (p === 1) bits |= 2;
    else if (p === 3) bits |= 1;
    else if (p === 4) bits |= 4;
    else if (p === 7) bits |= 16;
    else if (p === 9) bits |= 8;
    else if (p === 22) bits &= ~2;
    else if (p === 23) bits &= ~1;
    else if (p === 24) bits &= ~4;
    else if (p === 27) bits &= ~16;
    else if (p === 29) bits &= ~8;
    else if (p >= 30 && p <= 37) fg = theme.ansi[p - 30];
    else if (p >= 90 && p <= 97) fg = theme.ansi[p - 82];
    else if (p >= 40 && p <= 47) bg = theme.ansi[p - 40];
    else if (p >= 100 && p <= 107) bg = theme.ansi[p - 92];
    else if (p === 39) fg = undefined;
    else if (p === 49) bg = undefined;
    else if (p === 38 || p === 48) {
      let value: string | undefined;
      if (params[i + 1] === 5) {
        value = color256(params[i + 2] ?? -1, theme);
        i += 2;
      } else if (params[i + 1] === 2) {
        const [r, g, b] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
        value = `#${hex(r & 255)}${hex(g & 255)}${hex(b & 255)}`;
        i += 4;
      }
      if (p === 38) fg = value;
      else bg = value;
    }
  }
  return { fg, bg, bits };
}

/** Splits a line into styled runs, removing CSI and OSC escape sequences. */
export function ansiLine(
  line: string,
  state: AnsiState,
  theme: ResolvedSyntaxTheme,
): { runs: AnsiRun[]; state: AnsiState } {
  const runs: AnsiRun[] = [];
  let current = state;
  let text = "";
  let textStart = 0;
  const flush = () => {
    if (text === "") return;
    const inverse = (current.bits & 16) !== 0;
    const color = inverse ? (current.bg ?? theme.bg) : current.fg;
    const bgColor = inverse ? (current.fg ?? theme.fg) : current.bg;
    runs.push({
      content: text,
      offset: textStart,
      ...(color ? { color } : {}),
      ...(bgColor ? { bgColor } : {}),
      fontStyle: current.bits & 15,
    });
    text = "";
  };
  let segment = 0;
  const take = (end: number) => {
    if (end <= segment) return;
    if (text === "") textStart = segment;
    text += line.slice(segment, end);
  };
  for (let i = line.indexOf("\x1b"); i >= 0 && i < line.length; i = line.indexOf("\x1b", i)) {
    const kind = line[i + 1];
    if (kind !== "[" && kind !== "]") {
      i++;
      continue;
    }
    take(i);
    let j = i + 2;
    if (kind === "[") {
      while (j < line.length && line.charCodeAt(j) >= 0x30 && line.charCodeAt(j) <= 0x3f) j++;
      while (j < line.length && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2f) j++;
      if (line[j] === "m") {
        flush();
        const raw = line.slice(i + 2, j);
        const params =
          raw === "" ? [] : raw.split(/[;:]/u).map((part) => (part === "" ? 0 : Number(part)));
        current = applySgr(current, params, theme);
      }
      j++;
    } else {
      while (
        j < line.length &&
        line.charCodeAt(j) !== 7 &&
        !(line.charCodeAt(j) === 27 && line[j + 1] === "\\")
      )
        j++;
      j += j < line.length && line.charCodeAt(j) === 27 ? 2 : 1;
    }
    i = segment = Math.min(j, line.length);
  }
  take(line.length);
  flush();
  return { runs, state: current };
}
