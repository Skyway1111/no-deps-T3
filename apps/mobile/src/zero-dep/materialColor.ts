// CAM16/HCT port of @material/material-color-utilities 0.3.0 (hct_solver, cam16, SchemeTonalSpot at contrast 0).
type Vec3 = [number, number, number];

const { PI, pow, abs, sign, sqrt, cos, sin, atan2, cbrt, round, floor, ceil, max, min } = Math;
const E = 216 / 24389;
const KAPPA = 24389 / 27;
const Y_FROM_LIN: Vec3 = [0.2126, 0.7152, 0.0722];
const XYZ_FROM_LIN = [[0.41233895, 0.35762064, 0.18051042], Y_FROM_LIN, [0.01932141, 0.11916382, 0.95034478]];
const CONE_FROM_XYZ = [[0.401288, 0.650173, -0.051461], [-0.250268, 1.204414, 0.045854], [-0.002079, 0.048952, 0.953127]];
const SCALED_DISCOUNT_FROM_LIN = [
  [0.001200833568784504, 0.002389694492170889, 0.0002795742885861124],
  [0.0005891086651375999, 0.0029785502573438758, 0.0003270666104008398],
  [0.00010146692491640572, 0.0005364214359186694, 0.0032979401770712076],
];
const LIN_FROM_SCALED_DISCOUNT = [
  [1373.2198709594231, -1100.4251190754821, -7.278681089101213],
  [-271.815969077903, 559.6580465940733, -32.46047482791194],
  [1.9622899599665666, -57.173814538844006, 308.7233197812385],
];
const mul = (v: number[], m: number[][]): Vec3 =>
  m.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!) as Vec3;

const labF = (t: number) => (t > E ? cbrt(t) : (KAPPA * t + 16) / 116);
const labInvf = (f: number) => (f ** 3 > E ? f ** 3 : (116 * f - 16) / KAPPA);
const yFromLstar = (l: number) => 100 * labInvf((l + 16) / 116);
const linearized = (c: number) => {
  const n = c / 255;
  return (n <= 0.040449936 ? n / 12.92 : pow((n + 0.055) / 1.055, 2.4)) * 100;
};
const delinearizedRaw = (l: number) => {
  const n = l / 100;
  return n <= 0.0031308 ? n * 12.92 : 1.055 * pow(n, 1 / 2.4) - 0.055;
};
const delinearized = (l: number) => min(255, max(0, round(delinearizedRaw(l) * 255)));
const argbFromRgb = (r: number, g: number, b: number) => ((255 << 24) | (r << 16) | (g << 8) | b) >>> 0;
const argbFromLin = (v: number[]) => argbFromRgb(delinearized(v[0]!), delinearized(v[1]!), delinearized(v[2]!));
const linFromArgb = (argb: number): Vec3 => [linearized((argb >> 16) & 255), linearized((argb >> 8) & 255), linearized(argb & 255)];
const argbFromLstar = (l: number) => {
  const c = delinearized(yFromLstar(l));
  return argbFromRgb(c, c, c);
};
const sanitizeDeg = (d: number) => ((d % 360) + 360) % 360;
const sanitizeRad = (a: number) => (a + PI * 8) % (PI * 2);

// Default viewing conditions (D65, adapting luminance from L*50, background L*50, average surround).
const VC = (() => {
  const white: Vec3 = [95.047, 100, 108.883];
  const la = ((200 / PI) * yFromLstar(50)) / 100;
  const [rW, gW, bW] = mul(white, CONE_FROM_XYZ);
  const f = 1, c = 0.69, nc = f;
  const d = min(1, max(0, f * (1 - (1 / 3.6) * Math.exp((-la - 42) / 92))));
  const rgbD = [rW, gW, bW].map((w) => (d * 100) / w + 1 - d) as Vec3;
  const k = 1 / (5 * la + 1);
  const k4 = k ** 4;
  const fl = k4 * la + 0.1 * (1 - k4) ** 2 * cbrt(5 * la);
  const n = yFromLstar(50) / 100;
  const z = 1.48 + sqrt(n);
  const nbb = 0.725 / pow(n, 0.2);
  const rgbA = [rW, gW, bW].map((w, i) => {
    const p = pow((fl * rgbD[i]! * w) / 100, 0.42);
    return (400 * p) / (p + 27.13);
  });
  const aw = (2 * rgbA[0]! + rgbA[1]! + 0.05 * rgbA[2]!) * nbb;
  return { n, aw, nbb, ncb: nbb, c, nc, rgbD, fl, fLRoot: pow(fl, 0.25), z };
})();

const adapt = (x: number) => {
  const p = pow(abs(x), 0.42);
  return (sign(x) * 400 * p) / (p + 27.13);
};
const unadapt = (x: number) => sign(x) * pow(max(0, (27.13 * abs(x)) / (400 - abs(x))), 1 / 0.42);

export interface Hct {
  hue: number;
  chroma: number;
  tone: number;
}

export function hctFromArgb(argb: number): Hct {
  const lin = linFromArgb(argb);
  const xyz = mul(lin, XYZ_FROM_LIN);
  const [r, g, b] = mul(xyz, CONE_FROM_XYZ).map((v, i) => adapt((VC.fl * VC.rgbD[i]! * v) / 100)) as Vec3;
  const a = (11 * r - 12 * g + b) / 11;
  const bb = (r + g - 2 * b) / 9;
  const u = (20 * r + 20 * g + 21 * b) / 20;
  const p2 = (40 * r + 20 * g + b) / 20;
  const hue = sanitizeDeg((atan2(bb, a) * 180) / PI);
  const j = 100 * pow((p2 * VC.nbb) / VC.aw, VC.c * VC.z);
  const huePrime = hue < 20.14 ? hue + 360 : hue;
  const eHue = 0.25 * (cos((huePrime * PI) / 180 + 2) + 3.8);
  const t = ((50000 / 13) * eHue * VC.nc * VC.ncb * sqrt(a * a + bb * bb)) / (u + 0.305);
  const chroma = pow(t, 0.9) * pow(1.64 - pow(0.29, VC.n), 0.73) * sqrt(j / 100);
  return { hue, chroma, tone: 116 * labF(xyz[1] / 100) - 16 };
}

const hueOf = (lin: number[]) => {
  const [r, g, b] = mul(lin, SCALED_DISCOUNT_FROM_LIN).map(adapt) as Vec3;
  return atan2((r + g - 2 * b) / 9, (11 * r - 12 * g + b) / 11);
};
const cyclic = (a: number, b: number, c: number) => sanitizeRad(b - a) < sanitizeRad(c - a);
const CRITICAL_PLANES = Array.from({ length: 255 }, (_, i) => linearized(i + 0.5));
const trueDelinearized = (l: number) => delinearizedRaw(l) * 255;

function nthVertex(y: number, n: number): Vec3 | null {
  const a = n % 4 <= 1 ? 0 : 100;
  const b = n % 2 === 0 ? 0 : 100;
  const axis = n < 4 ? 0 : n < 8 ? 1 : 2;
  const v: Vec3 = axis === 0 ? [0, a, b] : axis === 1 ? [b, 0, a] : [a, b, 0];
  v[axis] = (y - Y_FROM_LIN.reduce((s, k, i) => s + (i === axis ? 0 : k * v[i]!), 0)) / Y_FROM_LIN[axis]!;
  return v[axis]! >= 0 && v[axis]! <= 100 ? v : null;
}

function bisectToLimit(y: number, target: number): number[] {
  let left: number[] = [], right: number[] = [], leftHue = 0, rightHue = 0, init = false, uncut = true;
  for (let n = 0; n < 12; n++) {
    const mid = nthVertex(y, n);
    if (!mid) continue;
    const midHue = hueOf(mid);
    if (!init) {
      left = right = mid;
      leftHue = rightHue = midHue;
      init = true;
    } else if (uncut || cyclic(leftHue, midHue, rightHue)) {
      uncut = false;
      if (cyclic(leftHue, target, midHue)) (right = mid), (rightHue = midHue);
      else (left = mid), (leftHue = midHue);
    }
  }
  leftHue = hueOf(left);
  for (let axis = 0; axis < 3; axis++) {
    if (left[axis] === right[axis]) continue;
    const up = left[axis]! < right[axis]!;
    let lP = (up ? floor : ceil)(trueDelinearized(left[axis]!) - 0.5);
    let rP = (up ? ceil : floor)(trueDelinearized(right[axis]!) - 0.5);
    for (let i = 0; i < 8 && abs(rP - lP) > 1; i++) {
      const mP = floor((lP + rP) / 2);
      const t = (CRITICAL_PLANES[mP]! - left[axis]!) / (right[axis]! - left[axis]!);
      const mid = left.map((l, k) => l + (right[k]! - l) * t);
      const midHue = hueOf(mid);
      if (cyclic(leftHue, target, midHue)) (right = mid), (rP = mP);
      else (left = mid), (leftHue = midHue), (lP = mP);
    }
  }
  return left.map((l, k) => (l + right[k]!) / 2);
}

function findResultByJ(h: number, chroma: number, y: number): number {
  let j = sqrt(y) * 11;
  const tInner = 1 / pow(1.64 - pow(0.29, VC.n), 0.73);
  const p1 = 0.25 * (cos(h + 2) + 3.8) * (50000 / 13) * VC.nc * VC.ncb;
  const hS = sin(h), hC = cos(h);
  for (let round = 0; round < 5; round++) {
    const jn = j / 100;
    const alpha = chroma === 0 || j === 0 ? 0 : chroma / sqrt(jn);
    const t = pow(alpha * tInner, 1 / 0.9);
    const p2 = (VC.aw * pow(jn, 1 / VC.c / VC.z)) / VC.nbb;
    const gamma = (23 * (p2 + 0.305) * t) / (23 * p1 + 11 * t * hC + 108 * t * hS);
    const a = gamma * hC, b = gamma * hS;
    const lin = mul(
      [(460 * p2 + 451 * a + 288 * b) / 1403, (460 * p2 - 891 * a - 261 * b) / 1403, (460 * p2 - 220 * a - 6300 * b) / 1403].map(unadapt),
      LIN_FROM_SCALED_DISCOUNT,
    );
    if (lin[0] < 0 || lin[1] < 0 || lin[2] < 0) return 0;
    const fnj = Y_FROM_LIN[0] * lin[0] + Y_FROM_LIN[1] * lin[1] + Y_FROM_LIN[2] * lin[2];
    if (fnj <= 0) return 0;
    if (round === 4 || abs(fnj - y) < 0.002) return lin.some((v) => v > 100.01) ? 0 : argbFromLin(lin);
    j -= ((fnj - y) * j) / (2 * fnj);
  }
  return 0;
}

/** Closest sRGB color to the requested HCT; chroma is clamped to the gamut. */
export function argbFromHct(hue: number, chroma: number, tone: number): number {
  if (chroma < 0.0001 || tone < 0.0001 || tone > 99.9999) return argbFromLstar(tone);
  const h = (sanitizeDeg(hue) / 180) * PI;
  const y = yFromLstar(tone);
  return findResultByJ(h, chroma, y) || argbFromLin(bisectToLimit(y, h));
}

export function argbFromHex(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  else if (h.length === 8) h = h.slice(2);
  if (h.length !== 6) throw new Error(`unexpected hex ${hex}`);
  return (0xff000000 | parseInt(h, 16)) >>> 0;
}

export const hexFromArgb = (argb: number) => `#${(argb & 0xffffff).toString(16).padStart(6, "0")}`;

/** Re-tone a color, keeping its HCT hue and chroma. */
export function withTone(argb: number, tone: number): number {
  const { hue, chroma } = hctFromArgb(argb);
  return argbFromHct(hue, chroma, tone);
}

const ROLES = {
  primary: ["p", 40, 80],
  onPrimary: ["p", 100, 20],
  primaryContainer: ["p", 90, 30],
  onPrimaryContainer: ["p", 30, 90],
  inversePrimary: ["p", 80, 40],
  surfaceTint: ["p", 40, 80],
  secondary: ["s", 40, 80],
  onSecondary: ["s", 100, 20],
  secondaryContainer: ["s", 90, 30],
  onSecondaryContainer: ["s", 30, 90],
  tertiary: ["t", 40, 80],
  onTertiary: ["t", 100, 20],
  tertiaryContainer: ["t", 90, 30],
  onTertiaryContainer: ["t", 30, 90],
  error: ["e", 40, 80],
  onError: ["e", 100, 20],
  errorContainer: ["e", 90, 30],
  onErrorContainer: ["e", 30, 90],
  background: ["n", 98, 6],
  onBackground: ["n", 10, 90],
  surface: ["n", 98, 6],
  onSurface: ["n", 10, 90],
  surfaceDim: ["n", 87, 6],
  surfaceBright: ["n", 98, 24],
  surfaceContainerLowest: ["n", 100, 4],
  surfaceContainerLow: ["n", 96, 10],
  surfaceContainer: ["n", 94, 12],
  surfaceContainerHigh: ["n", 92, 17],
  surfaceContainerHighest: ["n", 90, 22],
  inverseSurface: ["n", 20, 90],
  inverseOnSurface: ["n", 95, 20],
  shadow: ["n", 0, 0],
  scrim: ["n", 0, 0],
  surfaceVariant: ["v", 90, 30],
  onSurfaceVariant: ["v", 30, 80],
  outline: ["v", 50, 60],
  outlineVariant: ["v", 80, 30],
} as const satisfies Record<string, readonly ["p" | "s" | "t" | "e" | "n" | "v", number, number]>;

export type SchemeRole = keyof typeof ROLES;
export type Scheme = Record<SchemeRole, number>;

/** Material 3 "tonal spot" scheme (Android 12+ default) for a seed color, at standard contrast. */
export function schemeTonalSpot(seed: number, dark: boolean): Scheme {
  const { hue } = hctFromArgb(seed);
  const palettes = { p: [hue, 36], s: [hue, 16], t: [sanitizeDeg(hue + 60), 24], e: [25, 84], n: [hue, 6], v: [hue, 8] };
  const scheme = {} as Scheme;
  for (const role in ROLES) {
    const [p, light, darkTone] = ROLES[role as SchemeRole];
    const [h, c] = palettes[p];
    scheme[role as SchemeRole] = argbFromHct(h!, c!, dark ? darkTone : light);
  }
  return scheme;
}
