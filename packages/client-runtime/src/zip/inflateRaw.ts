// Synchronous RFC 1951 raw-DEFLATE decoder. Throws RangeError when output would exceed maxOut.

const LEN_BASE = Uint16Array.of(3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258);
const LEN_EXTRA = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0);
const DIST_BASE = Uint16Array.of(1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577);
const DIST_EXTRA = Uint8Array.of(0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13);
const CL_ORDER = Uint8Array.of(16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);

const REV8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) r |= ((i >> b) & 1) << (7 - b);
  REV8[i] = r;
}

const counts = new Uint16Array(16);
const nextCode = new Uint16Array(16);
const litScratch = new Uint16Array(1 << 15);
const distScratch = new Uint16Array(1 << 15);
const clScratch = new Uint16Array(1 << 7);
const lengths = new Uint8Array(320);
const clLengths = new Uint8Array(19);

const corrupt = () => new Error("Invalid deflate data");

/** Fills `table` (indexed by bit-reversed code) with `sym << 4 | len`; returns the index bit width. */
function buildTable(lens: Uint8Array, table: Uint16Array): number {
  counts.fill(0);
  let max = 0;
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i]!;
    counts[l]!++;
    if (l > max) max = l;
  }
  counts[0] = 0;
  let left = 1;
  for (let l = 1; l <= 15; l++) if ((left = (left << 1) - counts[l]!) < 0) throw corrupt();
  for (let l = 1, code = 0; l <= 15; l++) nextCode[l] = code = (code + counts[l - 1]!) << 1;
  const size = 1 << max;
  table.fill(0, 0, size);
  for (let sym = 0; sym < lens.length; sym++) {
    const l = lens[sym]!;
    if (l === 0) continue;
    const c = nextCode[l]!++;
    const entry = (sym << 4) | l;
    for (let j = ((REV8[c & 255]! << 8) | REV8[c >> 8]!) >>> (16 - l); j < size; j += 1 << l) table[j] = entry;
  }
  return max;
}

const fixedLit = new Uint16Array(1 << 9);
const fixedDist = new Uint16Array(1 << 5);
{
  const l = new Uint8Array(288);
  l.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
  buildTable(l, fixedLit);
  buildTable(new Uint8Array(30).fill(5), fixedDist);
}

function grow(out: Uint8Array<ArrayBuffer>, need: number, maxOut: number) {
  if (need > maxOut) throw new RangeError("Inflated data exceeds limit");
  const next = new Uint8Array(Math.min(maxOut, Math.max(need, out.length * 2)));
  next.set(out);
  return next;
}

export function inflateRaw(src: Uint8Array, sizeHint = 0, maxOut = Infinity): Uint8Array<ArrayBuffer> {
  let out = new Uint8Array(Math.min(maxOut, sizeHint > 0 ? sizeHint : src.length * 4 + 256));
  // Reads past the end yield undefined (→ 0); `i` overshooting src by more than 4 bytes means truncation.
  const lastByte = src.length + 4;
  let i = 0;
  let o = 0;
  let hold = 0;
  let nb = 0;

  let final: number;
  do {
    while (nb < 24) { hold |= src[i++]! << nb; nb += 8; }
    final = hold & 1;
    const type = (hold >>> 1) & 3;
    hold >>>= 3;
    nb -= 3;
    if (type === 0) {
      i -= nb >> 3;
      hold = nb = 0;
      if (i + 4 > src.length) throw corrupt();
      const len = src[i]! | (src[i + 1]! << 8);
      if ((len ^ (src[i + 2]! | (src[i + 3]! << 8))) !== 0xffff || i + 4 + len > src.length) throw corrupt();
      if (o + len > out.length) out = grow(out, o + len, maxOut);
      out.set(src.subarray(i + 4, i + 4 + len), o);
      o += len;
      i += 4 + len;
      continue;
    }
    let lt = fixedLit;
    let dt = fixedDist;
    let lMask = 511;
    let dMask = 31;
    if (type === 2) {
      const hlit = (hold & 31) + 257;
      const hdist = ((hold >>> 5) & 31) + 1;
      const hclen = ((hold >>> 10) & 15) + 4;
      hold >>>= 14;
      nb -= 14;
      clLengths.fill(0);
      for (let k = 0; k < hclen; k++) {
        if (nb < 3) { hold |= src[i++]! << nb; nb += 8; }
        clLengths[CL_ORDER[k]!] = hold & 7;
        hold >>>= 3;
        nb -= 3;
      }
      const clMask = (1 << buildTable(clLengths, clScratch)) - 1;
      const n = hlit + hdist;
      for (let k = 0; k < n; ) {
        while (nb < 24) { hold |= src[i++]! << nb; nb += 8; }
        const e = clScratch[hold & clMask]!;
        if (e === 0) throw corrupt();
        hold >>>= e & 15;
        nb -= e & 15;
        const sym = e >> 4;
        if (sym < 16) { lengths[k++] = sym; continue; }
        let fill = 0;
        let rep: number;
        if (sym === 16) {
          if (k === 0) throw corrupt();
          fill = lengths[k - 1]!;
          rep = 3 + (hold & 3);
          hold >>>= 2;
          nb -= 2;
        } else if (sym === 17) {
          rep = 3 + (hold & 7);
          hold >>>= 3;
          nb -= 3;
        } else {
          rep = 11 + (hold & 127);
          hold >>>= 7;
          nb -= 7;
        }
        if (k + rep > n) throw corrupt();
        lengths.fill(fill, k, (k += rep));
      }
      if (i > lastByte || lengths[256] === 0) throw corrupt();
      lMask = (1 << buildTable(lengths.subarray(0, hlit), litScratch)) - 1;
      dMask = (1 << buildTable(lengths.subarray(hlit, n), distScratch)) - 1;
      lt = litScratch;
      dt = distScratch;
    } else if (type !== 1) throw corrupt();

    for (;;) {
      if (nb < 15) { hold |= (src[i]! << nb) | (src[i + 1]! << (nb + 8)); i += 2; nb += 16; }
      const e = lt[hold & lMask]!;
      if (e === 0 || i > lastByte) throw corrupt();
      hold >>>= e & 15;
      nb -= e & 15;
      const sym = e >> 4;
      if (sym < 256) {
        if (o >= out.length) out = grow(out, o + 1, maxOut);
        out[o++] = sym;
        continue;
      }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= 29) throw corrupt();
      const le = LEN_EXTRA[li]!;
      if (nb < le) { hold |= src[i++]! << nb; nb += 8; }
      const len = LEN_BASE[li]! + (hold & ((1 << le) - 1));
      hold >>>= le;
      nb -= le;
      if (nb < 15) { hold |= (src[i]! << nb) | (src[i + 1]! << (nb + 8)); i += 2; nb += 16; }
      const de = dt[hold & dMask]!;
      if (de === 0) throw corrupt();
      hold >>>= de & 15;
      nb -= de & 15;
      const di = de >> 4;
      if (di >= 30) throw corrupt();
      const dx = DIST_EXTRA[di]!;
      if (nb < dx) { hold |= (src[i]! << nb) | (src[i + 1]! << (nb + 8)); i += 2; nb += 16; }
      const dist = DIST_BASE[di]! + (hold & ((1 << dx) - 1));
      hold >>>= dx;
      nb -= dx;
      if (dist > o) throw corrupt();
      if (o + len > out.length) out = grow(out, o + len, maxOut);
      if (dist >= len && len > 8) {
        out.copyWithin(o, o - dist, o - dist + len);
        o += len;
      } else for (let s = o - dist, end = o + len; o < end; ) out[o++] = out[s++]!;
    }
  } while (!final);
  if (i * 8 - nb > src.length * 8) throw corrupt();
  return o === out.length ? out : out.subarray(0, o);
}
