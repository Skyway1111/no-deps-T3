// CSS color parsing (culori 4 `parse` semantics) and sRGB / OKLab / OKLCH / HSL / hex / WCAG math.

/** Gamma-encoded sRGB channels in 0..1 (unclamped: wide-gamut inputs fall outside). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  alpha?: number | undefined;
}
export interface Oklab {
  l: number;
  a: number;
  b: number;
  alpha?: number | undefined;
}
/** `h` is absent for achromatic colors. */
export interface Oklch {
  l: number;
  c: number;
  h?: number | undefined;
  alpha?: number | undefined;
}
export interface Hsl {
  h?: number | undefined;
  s: number;
  l: number;
  alpha?: number | undefined;
}

type Mode =
  | "rgb"
  | "lrgb"
  | "hsl"
  | "hwb"
  | "lab"
  | "lch"
  | "oklab"
  | "oklch"
  | "p3"
  | "a98"
  | "prophoto"
  | "rec2020"
  | "xyz50"
  | "xyz65";

const normalizeHue = (h: number) => ((h %= 360) < 0 ? h + 360 : h);

const srgbToLinear = (c: number) => {
  const abs = Math.abs(c);
  return abs <= 0.04045 ? c / 12.92 : (Math.sign(c) || 1) * ((abs + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (c: number) => {
  const abs = Math.abs(c);
  return abs > 0.0031308 ? (Math.sign(c) || 1) * (1.055 * abs ** (1 / 2.4) - 0.055) : c * 12.92;
};

// Conversions write their result to these scratch registers instead of allocating.
let R = 0,
  G = 0,
  B = 0; // sRGB (or linear, where noted)
let OL = 0,
  OA = 0,
  OB = 0; // OKLab

type M3 = readonly [number, number, number, number, number, number, number, number, number];
const XYZ65_TO_LRGB: M3 = [
  3.2409699419045226, -1.5373831775700939, -0.4986107602930034, -0.9692436362808796,
  1.8759675015077204, 0.0415550574071756, 0.0556300796969936, -0.2039769588889765,
  1.0569715142428784,
];
const XYZ50_TO_LRGB: M3 = [
  3.1341359569958707, -1.6173863321612538, -0.4906619460083532, -0.978795502912089,
  1.916254567259524, 0.03344273116131949, 0.07195537988411677, -0.2289768264158322,
  1.405386058324125,
];
const P3_TO_XYZ65: M3 = [
  0.486570948648216, 0.265667693169093, 0.1982172852343625, 0.2289745640697487, 0.6917385218365062,
  0.079286914093745, 0, 0.0451133818589026, 1.043944368900976,
];
const A98_TO_XYZ65: M3 = [
  0.5766690429101305, 0.1855582379065463, 0.1882286462349947, 0.297344975250536, 0.6273635662554661,
  0.0752914584939979, 0.0270313613864123, 0.0706888525358272, 0.9913375368376386,
];
const PROPHOTO_TO_XYZ50: M3 = [
  0.7977666449006423, 0.1351812974005331, 0.0313477341283922, 0.2880748288194013,
  0.7118352342418731, 0.0000899369387256, 0, 0, 0.8251046025104602,
];
const REC2020_TO_XYZ65: M3 = [
  0.6369580483012911, 0.1446169035862083, 0.1688809751641721, 0.262700212011267, 0.6779980715188708,
  0.059301716469862, 0, 0.0280726930490874, 1.0609850577107909,
];
const D50X = 0.3457 / 0.3585,
  D50Z = (1 - 0.3457 - 0.3585) / 0.3585;

const row = (m: M3, i: number, x: number, y: number, z: number) =>
  m[i]! * x + m[i + 1]! * y + m[i + 2]! * z;
const fromXyz = (m: M3, x: number, y: number, z: number) => {
  R = linearToSrgb(row(m, 0, x, y, z));
  G = linearToSrgb(row(m, 3, x, y, z));
  B = linearToSrgb(row(m, 6, x, y, z));
};
const viaXyz = (to: M3, from: M3, x: number, y: number, z: number) =>
  fromXyz(to, row(from, 0, x, y, z), row(from, 3, x, y, z), row(from, 6, x, y, z));
const labF = (v: number) => (v ** 3 > 216 / 24389 ? v ** 3 : (116 * v - 16) / (24389 / 27));
const fromLab = (l: number, a: number, b: number) => {
  const fy = (l + 16) / 116;
  fromXyz(XYZ50_TO_LRGB, labF(a / 500 + fy) * D50X, labF(fy), labF(fy - b / 200) * D50Z);
};
const fromHsv = (h: number, s: number, v: number) => {
  h = normalizeHue(h);
  const f = Math.abs(((h / 60) % 2) - 1),
    y = v * (1 - s * f),
    z = v * (1 - s);
  switch (Math.floor(h / 60)) {
    case 0:
      R = v;
      G = y;
      B = z;
      break;
    case 1:
      R = y;
      G = v;
      B = z;
      break;
    case 2:
      R = z;
      G = v;
      B = y;
      break;
    case 3:
      R = z;
      G = y;
      B = v;
      break;
    case 4:
      R = y;
      G = z;
      B = v;
      break;
    case 5:
      R = v;
      G = z;
      B = y;
      break;
    default:
      R = G = B = z;
  }
};
const fromHsl = (h: number, s: number, l: number) => {
  h = normalizeHue(h);
  const m1 = l + s * (l < 0.5 ? l : 1 - l);
  const m2 = m1 - (m1 - l) * 2 * Math.abs(((h / 60) % 2) - 1);
  const lo = 2 * l - m1;
  switch (Math.floor(h / 60)) {
    case 0:
      R = m1;
      G = m2;
      B = lo;
      break;
    case 1:
      R = m2;
      G = m1;
      B = lo;
      break;
    case 2:
      R = lo;
      G = m1;
      B = m2;
      break;
    case 3:
      R = lo;
      G = m2;
      B = m1;
      break;
    case 4:
      R = m2;
      G = lo;
      B = m1;
      break;
    case 5:
      R = m1;
      G = lo;
      B = m2;
      break;
    default:
      R = G = B = lo;
  }
};
/** Gamma-encoded sRGB → OKLab registers; grays get exactly zero a/b, as in culori. */
const toLab = (r: number, g: number, b: number) => {
  const gray = r === g && g === b;
  r = srgbToLinear(r);
  g = srgbToLinear(g);
  b = srgbToLinear(b);
  const l = Math.cbrt(0.412221469470763 * r + 0.5363325372617348 * g + 0.0514459932675022 * b);
  const m = Math.cbrt(0.2119034958178252 * r + 0.6806995506452344 * g + 0.1073969535369406 * b);
  const s = Math.cbrt(0.0883024591900564 * r + 0.2817188391361215 * g + 0.6299787016738222 * b);
  OL = 0.210454268309314 * l + 0.7936177747023054 * m - 0.0040720430116193 * s;
  OA = 1.9779985324311684 * l - 2.4285922420485799 * m + 0.450593709617411 * s;
  OB = 0.0259040424655478 * l + 0.7827717124575296 * m - 0.8086757549230774 * s;
  if (gray) OA = OB = 0;
};
/** OKLab → linear sRGB registers. */
const labToLinear = (l: number, a: number, b: number) => {
  const L = (l + 0.3963377773761749 * a + 0.2158037573099136 * b) ** 3;
  const M = (l - 0.1055613458156586 * a - 0.0638541728258133 * b) ** 3;
  const S = (l - 0.0894841775298119 * a - 1.2914855480194092 * b) ** 3;
  R = 4.0767416360759574 * L - 3.3077115392580616 * M + 0.2309699031821044 * S;
  G = -1.2684379732850317 * L + 2.6097573492876887 * M - 0.3413193760026573 * S;
  B = -0.0041960761386756 * L - 0.7034186179359362 * M + 1.7076146940746117 * S;
};
const fromOklab = (l: number, a: number, b: number) => {
  labToLinear(l, a, b);
  R = linearToSrgb(R);
  G = linearToSrgb(G);
  B = linearToSrgb(B);
};
const polar = (c: number, h: number) => {
  const r = (h / 180) * Math.PI;
  OA = c ? c * Math.cos(r) : 0;
  OB = c ? c * Math.sin(r) : 0;
};

const rgbOut = (alpha: number | undefined): Rgb => {
  const o: Rgb = { r: R, g: G, b: B };
  if (alpha !== undefined) o.alpha = alpha;
  return o;
};
const labOut = (l: number, a: number, b: number, alpha: number | undefined): Oklab => {
  const o: Oklab = { l, a, b };
  if (alpha !== undefined) o.alpha = alpha;
  return o;
};
const lchOut = (l: number, a: number, b: number, alpha: number | undefined): Oklch => {
  const c = Math.sqrt(a * a + b * b);
  const o: Oklch = { l, c };
  if (c) o.h = normalizeHue((Math.atan2(b, a) * 180) / Math.PI);
  if (alpha !== undefined) o.alpha = alpha;
  return o;
};

export function oklabToRgb({ l, a, b, alpha }: Oklab): Rgb {
  fromOklab(l, a, b);
  return rgbOut(alpha);
}

const hex2 = (v: number) => {
  const n = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return (n < 16 ? "0" : "") + n.toString(16);
};
/** `#rrggbb`, or `#rrggbbaa` when alpha is below 1; channels are clamped to sRGB. */
export const rgbToHex = ({ r, g, b, alpha = 1 }: Rgb): string =>
  "#" + hex2(r) + hex2(g) + hex2(b) + (alpha < 1 ? hex2(alpha) : "");

// Single-pass, allocation-free port of culori's tokenizer, modern/legacy syntaxes, hex, names and color().
// `parse` returns the source mode and leaves the channels in these registers (undefined = `none`).

let X: number | undefined, Y: number | undefined, Z: number | undefined, A: number | undefined;

const NAMED_PACKED =
  "aliceblueF0F8FFantiquewhiteFAEBD7aqua00FFFFaquamarine7FFFD4azureF0FFFFbeigeF5F5DCbisqueFFE4C4black000000blanchedalmondFFEBCDblue0000FFbluevi" +
  "olet8A2BE2brownA52A2AburlywoodDEB887cadetblue5F9EA0chartreuse7FFF00chocolateD2691EcoralFF7F50cornflowerblue6495EDcornsilkFFF8DCcrimsonDC143C" +
  "cyan00FFFFdarkblue00008Bdarkcyan008B8BdarkgoldenrodB8860BdarkgrayA9A9A9darkgreen006400darkgreyA9A9A9darkkhakiBDB76Bdarkmagenta8B008Bdarkoliv" +
  "egreen556B2FdarkorangeFF8C00darkorchid9932CCdarkred8B0000darksalmonE9967Adarkseagreen8FBC8Fdarkslateblue483D8Bdarkslategray2F4F4Fdarkslategr" +
  "ey2F4F4Fdarkturquoise00CED1darkviolet9400D3deeppinkFF1493deepskyblue00BFFFdimgray696969dimgrey696969dodgerblue1E90FFfirebrickB22222floralwhi" +
  "teFFFAF0forestgreen228B22fuchsiaFF00FFgainsboroDCDCDCghostwhiteF8F8FFgoldFFD700goldenrodDAA520gray808080green008000greenyellowADFF2Fgrey8080" +
  "80honeydewF0FFF0hotpinkFF69B4indianredCD5C5Cindigo4B0082ivoryFFFFF0khakiF0E68ClavenderE6E6FAlavenderblushFFF0F5lawngreen7CFC00lemonchiffonFF" +
  "FACDlightblueADD8E6lightcoralF08080lightcyanE0FFFFlightgoldenrodyellowFAFAD2lightgrayD3D3D3lightgreen90EE90lightgreyD3D3D3lightpinkFFB6C1lig" +
  "htsalmonFFA07Alightseagreen20B2AAlightskyblue87CEFAlightslategray778899lightslategrey778899lightsteelblueB0C4DElightyellowFFFFE0lime00FF00li" +
  "megreen32CD32linenFAF0E6magentaFF00FFmaroon800000mediumaquamarine66CDAAmediumblue0000CDmediumorchidBA55D3mediumpurple9370DBmediumseagreen3CB" +
  "371mediumslateblue7B68EEmediumspringgreen00FA9Amediumturquoise48D1CCmediumvioletredC71585midnightblue191970mintcreamF5FFFAmistyroseFFE4E1moc" +
  "casinFFE4B5navajowhiteFFDEADnavy000080oldlaceFDF5E6olive808000olivedrab6B8E23orangeFFA500orangeredFF4500orchidDA70D6palegoldenrodEEE8AApaleg" +
  "reen98FB98paleturquoiseAFEEEEpalevioletredDB7093papayawhipFFEFD5peachpuffFFDAB9peruCD853FpinkFFC0CBplumDDA0DDpowderblueB0E0E6purple800080reb" +
  "eccapurple663399redFF0000rosybrownBC8F8Froyalblue4169E1saddlebrown8B4513salmonFA8072sandybrownF4A460seagreen2E8B57seashellFFF5EEsiennaA0522D" +
  "silverC0C0C0skyblue87CEEBslateblue6A5ACDslategray708090slategrey708090snowFFFAFAspringgreen00FF7Fsteelblue4682B4tanD2B48Cteal008080thistleD8" +
  "BFD8tomatoFF6347turquoise40E0D0violetEE82EEwheatF5DEB3whiteFFFFFFwhitesmokeF5F5F5yellowFFFF00yellowgreen9ACD32";
let namedColors: Map<string, number> | undefined;
const named = (name: string) =>
  (namedColors ??= new Map(
    Array.from(NAMED_PACKED.matchAll(/([a-z]+)([0-9A-F]{6})/g), (m) => [
      m[1]!,
      parseInt(m[2]!, 16),
    ]),
  )).get(name.toLowerCase());

const PROFILES = new Map<string, Mode>([
  ["a98-rgb", "a98"],
  ["display-p3", "p3"],
  ["prophoto-rgb", "prophoto"],
  ["rec2020", "rec2020"],
  ["srgb", "rgb"],
  ["srgb-linear", "lrgb"],
  ["xyz", "xyz65"],
  ["xyz-d65", "xyz65"],
  ["xyz-d50", "xyz50"],
]);

const digit = (c: number) => c >= 48 && c <= 57;
const identStart = (c: number) => c > 127 || c === 95 || ((c | 32) >= 97 && (c | 32) <= 122);
const identChar = (c: number) => identStart(c) || digit(c) || c === 45;
/** JS `\s` / `String#trim` whitespace. */
const space = (c: number) =>
  c === 32 ||
  (c >= 9 && c <= 13) ||
  (c >= 0x2000
    ? c <= 0x200a ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    : c === 0xa0 || c === 0x1680);
/** culori tokenizer whitespace. */
const tokSpace = (c: number) => c === 32 || c === 10 || c === 9;
const skip = (s: string, i: number) => {
  while (space(s.charCodeAt(i))) i++;
  return i;
};

const POW10 = Array.from({ length: 23 }, (_, k) => +`1e${k}`);
let end = 0;
/** CSS <number> at `i` (= culori's `num` digits and regex NUM): returns its value and sets `end`, or -1 there if none. */
function scanNum(s: string, i: number): number {
  let c = s.charCodeAt(i);
  const neg = c === 45;
  if (neg || c === 43) c = s.charCodeAt(++i);
  const start = i;
  let m = 0,
    n = 0,
    frac = 0,
    e = 0;
  for (; digit(c); c = s.charCodeAt(++i), n++) m = m * 10 + c - 48;
  if (c === 46 && digit(s.charCodeAt(i + 1)))
    for (c = s.charCodeAt(++i); digit(c); c = s.charCodeAt(++i), n++, frac++) m = m * 10 + c - 48;
  if (!n) return (end = -1);
  if (c === 101 || c === 69) {
    let j = i + 1,
      d = s.charCodeAt(j);
    const eneg = d === 45;
    if (eneg || d === 43) d = s.charCodeAt(++j);
    if (digit(d)) {
      for (i = j; digit(d); d = s.charCodeAt(++i)) e = e * 10 + d - 48;
      if (eneg) e = -e;
    }
  }
  end = i;
  // Exact (Clinger fast path) when mantissa and power of ten are both exact doubles.
  const p = e - frac;
  const v =
    n <= 15 && p >= -22 && p <= 22 ? (p < 0 ? m / POW10[-p]! : m * POW10[p]!) : +s.slice(start, i);
  return neg ? -v : v;
}
/** Hue unit multiplier for the identifier `s[i, j)`, or 0. */
const hueUnit = (s: string, i: number, j: number) =>
  j - i === 3
    ? s.startsWith("deg", i)
      ? 1
      : s.startsWith("rad", i)
        ? 180 / Math.PI
        : 0
    : j - i === 4
      ? s.startsWith("turn", i)
        ? 360
        : s.startsWith("grad", i)
          ? 9 / 10
          : 0
      : 0;

const NONE = 0,
  NUM = 1,
  PCT = 2,
  HUE = 3;
const kinds = [0, 0, 0, 0];
const vals = [0.5, 0.5, 0.5, 0.5];
let tokKind = 0,
  tokVal = 0;

/** culori `num` token at `i` (precondition: is_num): sets tokKind/tokVal and returns the end, or -1 on a bad unit. */
function numToken(s: string, i: number): number {
  const v = scanNum(s, i);
  i = end;
  const c = s.charCodeAt(i);
  if (
    identStart(c) ||
    (c === 45 &&
      i + 1 < s.length &&
      (s.charCodeAt(i + 1) === 45 || identStart(s.charCodeAt(i + 1))))
  ) {
    let j = i + 1;
    while (identChar(s.charCodeAt(j))) j++;
    const unit = hueUnit(s, i, j);
    if (!unit) return -1;
    tokKind = HUE;
    tokVal = v * unit;
    return j;
  }
  tokVal = v;
  if (c === 37) {
    tokKind = PCT;
    return i + 1;
  }
  tokKind = NUM;
  return i;
}
const isNum = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  if (c === 43 || c === 45) {
    const c1 = s.charCodeAt(i + 1);
    return digit(c1) || (c1 === 46 && digit(s.charCodeAt(i + 2)));
  }
  return c === 46 ? digit(s.charCodeAt(i + 1)) : digit(c);
};
const alphaOf = (k: number, v: number) =>
  k === NONE ? undefined : Math.min(1, Math.max(0, k === NUM ? v : v / 100));

/** Modern `fn(c1 c2 c3 [/ alpha])` and `color(profile …)`: tokenizes and validates coords in one pass. */
function modern(s: string): Mode | undefined {
  let n = s.length;
  if (n && (space(s.charCodeAt(0)) || space(s.charCodeAt(n - 1)))) n = (s = s.trim()).length;
  if (!identStart(s.charCodeAt(0))) return;
  let i = 1;
  while (identChar(s.charCodeAt(i))) i++;
  if (s.charCodeAt(i) !== 40) return;
  const fn = s.slice(0, i++);
  let profile: Mode | undefined;
  if (fn === "color") {
    while (tokSpace(s.charCodeAt(i))) i++;
    const j = i;
    if (!identStart(s.charCodeAt(i))) return;
    while (identChar(s.charCodeAt(++i)));
    if (s.charCodeAt(i) === 40 || !(profile = PROFILES.get(s.slice(j, i)))) return;
  }
  let count = 0;
  for (;;) {
    let c = s.charCodeAt(i);
    while (tokSpace(c)) c = s.charCodeAt(++i);
    if (i >= n) break;
    if (c === 41) {
      while (tokSpace(s.charCodeAt(++i)));
      if (i < n) return;
      break;
    }
    if (count === 4) return;
    const alpha = c === 47;
    if (alpha) {
      while (tokSpace(s.charCodeAt(++i)));
      if (isNum(s, i)) {
        if ((i = numToken(s, i)) < 0 || tokKind === HUE) return;
      } else if (s.startsWith("none", i) && !identChar(s.charCodeAt(i + 4))) {
        i += 4;
        tokKind = NONE;
      } else return;
    } else if (c === 43 || c === 45 || c === 46 || digit(c)) {
      if (!isNum(s, i) || (i = numToken(s, i)) < 0) return;
    } else if (
      s.startsWith("none", i) &&
      !identChar(s.charCodeAt(i + 4)) &&
      s.charCodeAt(i + 4) !== 40
    ) {
      i += 4;
      tokKind = NONE;
    } else return;
    if (alpha !== (count === 3) || (tokKind === HUE && profile)) return;
    kinds[count] = tokKind;
    vals[count++] = tokVal;
  }
  if (count < 3) return;
  const [k0, k1, k2] = kinds as [number, number, number];
  const [v0, v1, v2] = vals as [number, number, number];
  A = count === 4 ? alphaOf(kinds[3]!, vals[3]!) : undefined;
  const ch = (k: number, v: number, scale: number) =>
    k === NONE ? undefined : k === NUM ? v : (v * scale) / 100;
  const hue = (k: number, v: number) => (k === NONE ? undefined : v);
  if (profile) {
    X = ch(k0, v0, 1);
    Y = ch(k1, v1, 1);
    Z = ch(k2, v2, 1);
    return profile;
  }
  const unit = (k: number, v: number) => (k === NONE ? undefined : v / 100);
  switch (fn) {
    case "rgb":
    case "rgba":
      if (k0 === HUE || k1 === HUE || k2 === HUE) return;
      X = k0 === NONE ? undefined : k0 === NUM ? v0 / 255 : v0 / 100;
      Y = k1 === NONE ? undefined : k1 === NUM ? v1 / 255 : v1 / 100;
      Z = k2 === NONE ? undefined : k2 === NUM ? v2 / 255 : v2 / 100;
      return "rgb";
    case "hsl":
    case "hsla":
    case "hwb":
      if (k0 === PCT || k1 === HUE || k2 === HUE) return;
      X = hue(k0, v0);
      Y = unit(k1, v1);
      Z = unit(k2, v2);
      return fn === "hwb" ? "hwb" : "hsl";
    case "lab":
      if (k0 === HUE || k1 === HUE || k2 === HUE) return;
      X = k0 === NONE ? undefined : Math.min(Math.max(0, v0), 100);
      Y = ch(k1, v1, 125);
      Z = ch(k2, v2, 125);
      return "lab";
    case "lch":
      if (k0 === HUE || k2 === PCT) return;
      X = k0 === NONE ? undefined : Math.min(Math.max(0, v0), 100);
      Y = k1 === NONE ? undefined : Math.max(0, k1 === NUM ? v1 : (v1 * 150) / 100);
      Z = hue(k2, v2);
      return "lch";
    case "oklab":
      if (k0 === HUE || k1 === HUE || k2 === HUE) return;
      X = k0 === NONE ? undefined : Math.min(Math.max(0, k0 === NUM ? v0 : v0 / 100), 1);
      Y = ch(k1, v1, 0.4);
      Z = ch(k2, v2, 0.4);
      return "oklab";
    case "oklch":
      if (k0 === HUE || k2 === PCT) return;
      X = k0 === NONE ? undefined : Math.min(Math.max(0, k0 === NUM ? v0 : v0 / 100), 1);
      Y = k1 === NONE ? undefined : Math.max(0, k1 === NUM ? v1 : (v1 * 0.4) / 100);
      Z = hue(k2, v2);
      return "oklch";
  }
}

/** Legacy comma syntax `rgb[a](n, n, n[, a])`, `rgb[a](p%, p%, p%[, a])`, `hsl[a](h[unit], p%, p%[, a])`; regex-exact. */
function legacy(s: string): Mode | undefined {
  const hsl = s.startsWith("hsl");
  if (!hsl && !s.startsWith("rgb")) return;
  let i = s.charCodeAt(3) === 97 ? 4 : 3;
  if (s.charCodeAt(i) !== 40) return;
  let v = scanNum(s, skip(s, i + 1));
  if ((i = end) < 0) return;
  let pct = false;
  if (hsl) {
    const u = s.charCodeAt(i);
    const len = u === 100 || u === 114 ? 3 : u === 103 || u === 116 ? 4 : 0;
    if (len && hueUnit(s, i, i + len)) {
      // culori's `hueToDeg`, operation for operation.
      v = u === 100 ? v : u === 114 ? (v / Math.PI) * 180 : u === 103 ? (v / 10) * 9 : v * 360;
      i += len;
    }
    X = v;
    pct = true;
  } else if ((pct = s.charCodeAt(i) === 37)) i++;
  for (let k = hsl ? 1 : 0; k < 3; k++) {
    if (k) {
      if (s.charCodeAt((i = skip(s, i))) !== 44) return;
      v = scanNum(s, skip(s, i + 1));
      if ((i = end) < 0 || (s.charCodeAt(i) === 37) !== pct) return;
      if (pct) i++;
    }
    const c = hsl ? Math.min(Math.max(0, v / 100), 1) : v / (pct ? 100 : 255);
    if (k === 0) X = c;
    else if (k === 1) Y = c;
    else Z = c;
  }
  A = undefined;
  if (s.charCodeAt((i = skip(s, i))) === 44) {
    v = scanNum(s, skip(s, i + 1));
    if ((i = end) < 0) return;
    const p = s.charCodeAt(i) === 37;
    A = Math.max(0, Math.min(1, p ? v / 100 : v));
    i = skip(s, p ? i + 1 : i);
  }
  return s.charCodeAt(i) === 41 && i + 1 === s.length ? (hsl ? "hsl" : "rgb") : undefined;
}

const nib = (c: number) =>
  c <= 57 ? (c >= 48 ? c - 48 : -1) : (c |= 32) >= 97 && c <= 102 ? c - 87 : -1;
/** culori `parseNumber`: packed 3/4/6/8-digit hex → rgb registers. */
function fromNumber(n: number, len: number): Mode {
  const short = len < 5,
    a = len === 4 || len === 8,
    at = (k: number) => (short ? ((n >> (4 * k)) & 15) * 17 : (n >>> (8 * k)) & 255);
  const o = a ? 1 : 0;
  X = at(o + 2) / 255;
  Y = at(o + 1) / 255;
  Z = at(o) / 255;
  A = a ? at(0) / 255 : undefined;
  return "rgb";
}
/** `#?` + 3/4/6/8 hex digits from `i`. */
function hex(s: string, i: number): Mode | undefined {
  const len = s.length - i;
  if (len !== 3 && len !== 4 && len !== 6 && len !== 8) return;
  let n = 0;
  for (let k = i; k < s.length; k++) {
    const v = nib(s.charCodeAt(k));
    if (v < 0) return;
    n = n * 16 + v;
  }
  return fromNumber(n, len);
}

function parse(s: string): Mode | undefined {
  if (s.charCodeAt(0) === 35) return hex(s, 1);
  const mode = modern(s) ?? legacy(s) ?? hex(s, 0);
  if (mode) return mode;
  const n = named(s);
  if (n !== undefined) return fromNumber(n, 6);
  if (s !== "transparent") return;
  X = Y = Z = A = 0;
  return "rgb";
}

/** Parsed registers → sRGB registers. */
function toSrgb(mode: Mode) {
  const x = X ?? 0,
    y = Y ?? 0,
    z = Z ?? 0;
  switch (mode) {
    case "rgb":
      R = x;
      G = y;
      B = z;
      return;
    case "hsl":
      return fromHsl(x, y, z);
    case "hwb": {
      const [w, b] = y + z > 1 ? [y / (y + z), z / (y + z)] : [y, z];
      return fromHsv(x, b === 1 ? 1 : 1 - w / (1 - b), 1 - b);
    }
    case "lrgb":
      R = linearToSrgb(x);
      G = linearToSrgb(y);
      B = linearToSrgb(z);
      return;
    case "lab":
      return fromLab(x, y, z);
    case "lch":
      return fromLab(
        x,
        y ? y * Math.cos((z / 180) * Math.PI) : 0,
        y ? y * Math.sin((z / 180) * Math.PI) : 0,
      );
    case "oklab":
      return fromOklab(x, y, z);
    case "oklch":
      polar(y, z);
      return fromOklab(x, OA, OB);
    case "p3":
      return viaXyz(XYZ65_TO_LRGB, P3_TO_XYZ65, srgbToLinear(x), srgbToLinear(y), srgbToLinear(z));
    case "a98":
      return viaXyz(XYZ65_TO_LRGB, A98_TO_XYZ65, a98Linear(x), a98Linear(y), a98Linear(z));
    case "rec2020":
      return viaXyz(
        XYZ65_TO_LRGB,
        REC2020_TO_XYZ65,
        rec2020Linear(x),
        rec2020Linear(y),
        rec2020Linear(z),
      );
    case "prophoto":
      return viaXyz(
        XYZ50_TO_LRGB,
        PROPHOTO_TO_XYZ50,
        prophotoLinear(x),
        prophotoLinear(y),
        prophotoLinear(z),
      );
    case "xyz50":
      return fromXyz(XYZ50_TO_LRGB, x, y, z);
    case "xyz65":
      return fromXyz(XYZ65_TO_LRGB, x, y, z);
  }
}
const a98Linear = (v: number) => Math.abs(v) ** (563 / 256) * Math.sign(v);
const prophotoLinear = (v: number) =>
  Math.abs(v) >= 16 / 512 ? Math.sign(v) * Math.abs(v) ** 1.8 : v / 16;
const rec2020Linear = (v: number) => {
  const alpha = 1.09929682680944;
  return Math.abs(v) < 0.018053968510807 * 4.5
    ? v / 4.5
    : (Math.sign(v) || 1) * ((Math.abs(v) + alpha - 1) / alpha) ** (1 / 0.45);
};

/** Parses any CSS color culori's CSS build accepts. `alpha` is absent when unspecified or `none`. */
export function toRgb(css: string): Rgb | undefined {
  const mode = parse(css);
  if (!mode) return;
  toSrgb(mode);
  return rgbOut(A);
}

export function toOklab(css: string): Oklab | undefined {
  const mode = parse(css);
  if (!mode) return;
  if (mode === "oklab") return labOut(X ?? 0, Y ?? 0, Z ?? 0, A);
  if (mode === "oklch") return (polar(Y ?? 0, Z ?? 0), labOut(X ?? 0, OA, OB, A));
  toSrgb(mode);
  toLab(R, G, B);
  return labOut(OL, OA, OB, A);
}

/** Missing lightness or chroma reads as 0; a missing hue stays absent, as in CSS. */
export function toOklch(css: string): Oklch | undefined {
  const mode = parse(css);
  if (!mode) return;
  if (mode === "oklch") {
    const o: Oklch = Z === undefined ? { l: X ?? 0, c: Y ?? 0 } : { l: X ?? 0, c: Y ?? 0, h: Z };
    if (A !== undefined) o.alpha = A;
    return o;
  }
  if (mode === "oklab") return lchOut(X ?? 0, Y ?? 0, Z ?? 0, A);
  toSrgb(mode);
  toLab(R, G, B);
  return lchOut(OL, OA, OB, A);
}
