/**
 * Parses JSON with `//` and block comments and trailing commas, as VS Code reads its config files.
 * Returns `undefined` for malformed input, which no JSON document can parse to.
 */
export function parseJsonc(source: string): unknown {
  let out = "";
  let start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let comma = -1;
  let previous = 0;
  for (let i = start; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 0x22 /* " */) {
      for (i++; i < source.length && source.charCodeAt(i) !== 0x22; i++) {
        if (source.charCodeAt(i) === 0x5c /* \ */) i++;
      }
      comma = -1;
      previous = c;
    } else if (c === 0x2f /* / */ && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const end = source[i + 1] === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2) + 2;
      if (end === 1) return undefined;
      out += `${source.slice(start, i)} `;
      start = end < 0 ? source.length : end;
      i = start - 1;
    } else if (c === 0x2c /* , */) {
      out += source.slice(start, i);
      start = i;
      comma = previous === 0x5b || previous === 0x7b ? -1 : out.length;
      previous = c;
    } else if (c === 0x5d /* ] */ || c === 0x7d /* } */) {
      out += source.slice(start, i);
      start = i;
      if (comma >= 0) out = out.slice(0, comma) + out.slice(comma + 1);
      comma = -1;
      previous = c;
    } else if (c > 0x20) {
      comma = -1;
      previous = c;
    }
  }
  try {
    return JSON.parse(out + source.slice(start));
  } catch {
    return undefined;
  }
}
