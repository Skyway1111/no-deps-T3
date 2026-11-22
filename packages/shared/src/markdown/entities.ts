const WINDOWS_1252: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: "\u00a0",
  Tab: "\t",
  NewLine: "\n",
  excl: "!",
  num: "#",
  dollar: "$",
  percnt: "%",
  lpar: "(",
  rpar: ")",
  ast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  equals: "=",
  quest: "?",
  commat: "@",
  lsqb: "[",
  bsol: "\\",
  rsqb: "]",
  Hat: "^",
  lowbar: "_",
  grave: "`",
  lcub: "{",
  verbar: "|",
  rcub: "}",
  tilde: "~",
  NotEqualTilde: "\u2242\u0338",
  copy: "\u00a9",
  COPY: "\u00a9",
  reg: "\u00ae",
  REG: "\u00ae",
  trade: "\u2122",
  TRADE: "\u2122",
  iexcl: "\u00a1",
  cent: "\u00a2",
  pound: "\u00a3",
  curren: "\u00a4",
  yen: "\u00a5",
  brvbar: "\u00a6",
  sect: "\u00a7",
  uml: "\u00a8",
  ordf: "\u00aa",
  laquo: "\u00ab",
  not: "\u00ac",
  shy: "\u00ad",
  macr: "\u00af",
  deg: "\u00b0",
  plusmn: "\u00b1",
  sup2: "\u00b2",
  sup3: "\u00b3",
  acute: "\u00b4",
  micro: "\u00b5",
  para: "\u00b6",
  middot: "\u00b7",
  cedil: "\u00b8",
  sup1: "\u00b9",
  ordm: "\u00ba",
  raquo: "\u00bb",
  frac14: "\u00bc",
  frac12: "\u00bd",
  frac34: "\u00be",
  iquest: "\u00bf",
  times: "\u00d7",
  divide: "\u00f7",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  lrm: "\u200e",
  rlm: "\u200f",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  dagger: "\u2020",
  Dagger: "\u2021",
  bull: "\u2022",
  hellip: "\u2026",
  permil: "\u2030",
  prime: "\u2032",
  Prime: "\u2033",
  lsaquo: "\u2039",
  rsaquo: "\u203a",
  oline: "\u203e",
  euro: "\u20ac",
  larr: "\u2190",
  uarr: "\u2191",
  rarr: "\u2192",
  darr: "\u2193",
  harr: "\u2194",
  lArr: "\u21d0",
  uArr: "\u21d1",
  rArr: "\u21d2",
  dArr: "\u21d3",
  hArr: "\u21d4",
  forall: "\u2200",
  part: "\u2202",
  exist: "\u2203",
  empty: "\u2205",
  nabla: "\u2207",
  isin: "\u2208",
  notin: "\u2209",
  ni: "\u220b",
  prod: "\u220f",
  sum: "\u2211",
  minus: "\u2212",
  radic: "\u221a",
  prop: "\u221d",
  infin: "\u221e",
  and: "\u2227",
  or: "\u2228",
  cap: "\u2229",
  cup: "\u222a",
  int: "\u222b",
  there4: "\u2234",
  sim: "\u223c",
  cong: "\u2245",
  asymp: "\u2248",
  approx: "\u2248",
  ne: "\u2260",
  equiv: "\u2261",
  le: "\u2264",
  ge: "\u2265",
  sub: "\u2282",
  sup: "\u2283",
  nsub: "\u2284",
  sube: "\u2286",
  supe: "\u2287",
  oplus: "\u2295",
  otimes: "\u2297",
  perp: "\u22a5",
  sdot: "\u22c5",
  Alpha: "\u0391",
  Beta: "\u0392",
  Gamma: "\u0393",
  Delta: "\u0394",
  Epsilon: "\u0395",
  Zeta: "\u0396",
  Eta: "\u0397",
  Theta: "\u0398",
  Iota: "\u0399",
  Kappa: "\u039a",
  Lambda: "\u039b",
  Mu: "\u039c",
  Nu: "\u039d",
  Xi: "\u039e",
  Omicron: "\u039f",
  Pi: "\u03a0",
  Rho: "\u03a1",
  Sigma: "\u03a3",
  Tau: "\u03a4",
  Upsilon: "\u03a5",
  Phi: "\u03a6",
  Chi: "\u03a7",
  Psi: "\u03a8",
  Omega: "\u03a9",
  alpha: "\u03b1",
  beta: "\u03b2",
  gamma: "\u03b3",
  delta: "\u03b4",
  epsilon: "\u03b5",
  zeta: "\u03b6",
  eta: "\u03b7",
  theta: "\u03b8",
  iota: "\u03b9",
  kappa: "\u03ba",
  lambda: "\u03bb",
  mu: "\u03bc",
  nu: "\u03bd",
  xi: "\u03be",
  omicron: "\u03bf",
  pi: "\u03c0",
  rho: "\u03c1",
  sigmaf: "\u03c2",
  sigma: "\u03c3",
  tau: "\u03c4",
  upsilon: "\u03c5",
  phi: "\u03c6",
  chi: "\u03c7",
  psi: "\u03c8",
  omega: "\u03c9",
  check: "\u2713",
  cross: "\u2717",
  star: "\u2606",
  starf: "\u2605",
  spades: "\u2660",
  clubs: "\u2663",
  hearts: "\u2665",
  diams: "\u2666",
};

const LEGACY_NO_SEMI: Readonly<Record<string, string>> = {
  amp: "&",
  AMP: "&",
  lt: "<",
  LT: "<",
  gt: ">",
  GT: ">",
  quot: '"',
  QUOT: '"',
  nbsp: "\u00a0",
  copy: "\u00a9",
  COPY: "\u00a9",
  reg: "\u00ae",
  REG: "\u00ae",
};

function decodeNumericCodePoint(codePoint: number): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "\ufffd";
  }
  const mapped = WINDOWS_1252[codePoint];
  return String.fromCodePoint(mapped ?? codePoint);
}

function isAsciiAlphaNum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

/**
 * Decodes HTML character references (named, decimal, hex) with optional strict semicolon mode
 * and HTML attribute mode (where `&copy=2` is kept literal).
 */
export function decodeHtmlEntities(
  input: string,
  options?: { readonly strict?: boolean; readonly attribute?: boolean },
): string {
  if (!input.includes("&")) return input;
  const strict = options?.strict ?? false;
  const attribute = options?.attribute ?? false;
  const len = input.length;
  let out = "";
  let last = 0;

  for (let i = 0; i < len; i++) {
    if (input.charCodeAt(i) !== 38 /* & */) continue;
    const next = i + 1;
    if (next >= len) break;
    const c1 = input.charCodeAt(next);

    if (c1 === 35 /* # */) {
      let pos = next + 1;
      if (pos >= len) continue;
      const c2 = input.charCodeAt(pos);
      const isHex = c2 === 120 /* x */ || c2 === 88 /* X */;
      if (isHex) pos++;
      const digitsStart = pos;
      if (isHex) {
        while (pos < len && isHexDigit(input.charCodeAt(pos))) pos++;
      } else {
        while (pos < len && input.charCodeAt(pos) >= 48 && input.charCodeAt(pos) <= 57) pos++;
      }
      const digitCount = pos - digitsStart;
      if (digitCount === 0) continue;
      const hasSemi = pos < len && input.charCodeAt(pos) === 59 /* ; */;
      if (strict && !hasSemi) continue;
      if (strict && ((isHex && digitCount > 6) || (!isHex && digitCount > 7))) continue;
      const end = hasSemi ? pos + 1 : pos;
      const rawNum = input.slice(digitsStart, pos);
      const cp = Number.parseInt(rawNum, isHex ? 16 : 10);
      out += input.slice(last, i) + decodeNumericCodePoint(cp);
      last = end;
      i = end - 1;
      continue;
    }

    if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
      let pos = next + 1;
      const maxEnd = Math.min(len, next + 32);
      while (pos < maxEnd && isAsciiAlphaNum(input.charCodeAt(pos))) pos++;
      const name = input.slice(next, pos);
      const hasSemi = pos < len && input.charCodeAt(pos) === 59 /* ; */;
      if (hasSemi) {
        const decoded = NAMED_ENTITIES[name];
        if (decoded !== undefined) {
          out += input.slice(last, i) + decoded;
          last = pos + 1;
          i = pos;
        }
      } else if (!strict) {
        const decoded = LEGACY_NO_SEMI[name];
        if (decoded !== undefined) {
          const after = pos < len ? input.charCodeAt(pos) : 0;
          // In attributes, legacy entities without `;` followed by `=` or alnum stay literal.
          if (attribute && (after === 61 /* = */ || isAsciiAlphaNum(after))) continue;
          out += input.slice(last, i) + decoded;
          last = pos;
          i = pos - 1;
        }
      }
    }
  }

  return last === 0 ? input : out + input.slice(last);
}

export function escapeHtmlText(value: string): string {
  if (!value.includes("&") && !value.includes("<") && !value.includes(">")) return value;
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    let rep: string | undefined;
    if (c === 38) rep = "&amp;";
    else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    if (rep !== undefined) {
      out += value.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? value : out + value.slice(last);
}

export function escapeHtmlAttr(value: string): string {
  if (!value.includes("&") && !value.includes('"')) return value;
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    let rep: string | undefined;
    if (c === 38) rep = "&amp;";
    else if (c === 34) rep = "&quot;";
    if (rep !== undefined) {
      out += value.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? value : out + value.slice(last);
}
