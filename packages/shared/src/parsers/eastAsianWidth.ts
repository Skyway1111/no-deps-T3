// East Asian Width W ∪ F ranges (get-east-asian-width 1.6.0 data) as base36 "gapFromPreviousEnd,length" pairs.
const PACKED =
  "3cw,2n 3i3,1 e,1 5b,3 4,0 3,0 ei,1 m,1 r,7 h,b 18,0 b,5 4,0 e,0 9,1 i,1 6,1 9,0 6,0 m,0 8,1 2,0 5,0 3,0 8,0 5,1 t,0 10,0 2,0 5,2 2,0 1q,2 p,0 f,0 nw,1 1g,0 5,0 mj,p 2,2g d,5x r,26 3,2d 3,2u 6,16 2,2l 2,2d a,1b 2,13 9,mkc 4,1i wq,s hw,8mb 6l9,e7 lt,9 n,y 2,i 2,3 46,2n 3k,6 m4a,4 c,6 a,5p1 16,v 2q,36 6pq,3 2,6 2,1 2,82 g,0 u,2 3,0 f,3 9,az 6bp,2e a,m 5n2,0 5n,0 5b,0 3,9 2u,2 e,17 5,8 8,1 f,5 4b,w d,8 2,1x 2,l d,16 5,4 d,g 4,0 4,1y 2,0 2,56 3,1q e,3 2,n j,0 r,1 e,0 2f,2c 1d,1x 7,0 4,2 3,3 4,3 c,1 8,8 6c,b 5,0 7w,1a 2,9 2,54 35,c 4,a 4,1k 2,0 5,f 3,b 5,9 zs,1ekd 3,1ekd";

/** Bitmap of wide code points below 0x40000 (none lie above), built on first use. */
let WIDE: Int32Array | undefined;
function wide(): Int32Array {
  const bits = new Int32Array(0x2000);
  for (let end = 0, k = 0, pairs = PACKED.split(" "); k < pairs.length; k++) {
    const [gap, length] = pairs[k]!.split(",").map((part) => parseInt(part, 36)) as [
      number,
      number,
    ];
    let cp = (end += gap);
    end += length;
    while (cp <= end)
      if ((cp & 31) === 0 && cp + 31 <= end) ((bits[cp >> 5] = -1), (cp += 32));
      else bits[cp >> 5]! |= 1 << cp++;
  }
  return (WIDE = bits);
}

/** Terminal cell width of a code point: 2 for East Asian Wide/Fullwidth, else 1. */
export function eastAsianWidth(codePoint: number): 1 | 2 {
  return codePoint >= 0x1100 &&
    codePoint <= 0x3fffd &&
    ((WIDE ?? wide())[codePoint >> 5]! >>> codePoint) & 1
    ? 2
    : 1;
}
