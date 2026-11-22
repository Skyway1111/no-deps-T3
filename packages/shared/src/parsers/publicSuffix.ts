// A Public Suffix List subset: ICANN `<label>.<ccTLD>` rules for the common second-level labels,
// a few wildcard ccTLDs, and the major hosting/tunnel platforms from the private section. Any
// other TLD is its own suffix, per the list's implicit `*` rule.
const CCTLD_SECOND_LEVELS: Record<string, string> = {
  com: "ac af ag ai al am ar au aw az ba bb bd bh bi bj bm bn bo br bs bt by bz ci cm cn co cu cv cw cy dm do dz ec ee eg es et fj fm fr ge gh gi gl gn gp gr gt gu gy hk hn hr ht im in io iq jo kg kh ki km kp kw ky kz la lb lc lk lr lv ly mg mk ml mo ms mt mu mv mw mx my na nf ng ni nr om pa pe pf ph pk pl pr ps pt py qa re ro sa sb sc sd sg sh sl sn so ss st sv sy tj tm tn to tr tt tw ua ug uy uz vc ve vi vn vu ws ye zm",
  net: "ac ae af ag ai al am ar au az ba bb bd bh bj bm bn bo br bs bt bw bz ci cm cn co cu cv cw cy dm do dz ec eg et fj fm ge gg gh gl gn gp gr gt gu gy hk hn ht id il im in io iq ir je jo kg kh ki kn kw ky kz la lb lc lk lr ls lv ly ma me mk ml mo ms mt mu mv mw mx my mz na nf ng ni nr nz om pa pe ph pk pl pn pr ps pt py qa rw sa sb sc sd sg sh sl so ss st sy th tj tm tn to tr tt tw ua uk uy uz vc ve vi vn vu ws ye za zm",
  org: "ac ae af ag ai al am ao ar au az ba bb bd bh bi bj bm bn bo br bs bt bw bz ci cn co cu cv cw cy dm do dz ec ee eg es et fj fm ge gg gh gi gl gn gp gr gt gu gy hk hn ht hu il im in io iq ir je jo kg kh ki km kn kp kw ky kz la lb lc lk lr ls lv ly ma me mg mk ml mn mo ms mt mu mv mw mx my mz na ng ni nr nz om pa pe pf ph pk pl pn pr ps pt py qa ro rs rw sa sb sc sd se sg sh sk sl sn so ss st sv sy sz tj tm tn to tr tt tw ua ug uk uy uz vc ve vi vn vu ws ye za zm zw",
  edu: "ac af al ao ar au az ba bb bd bh bi bj bm bn bo br bs bt bz ci cn co cu cv cw dm do dz ec ee eg es et fj fm gd ge gh gi gl gn gp gr gt gu gy hk hn ht in io iq it jo kg kh ki km kn kp kw ky kz la lb lc lk lr ls lv ly me mg mk ml mn mo ms mt mv mw mx my mz ng ni nr om pa pe pf ph pk pl pn pr ps pt py qa rs sa sb sc sd sg sl sn so ss st sv sy tj tm to tr tt tw ua ug uy vc ve vg vn vu ws ye za zm",
  gov: "ac ae af al ao ar as au az ba bb bd bf bh bm bn br bs bt bw by bz cd cl cm cn co cx cy cz dm do dz ec ee eg et fj gd ge gh gi gn gr gu gy hk ie il in io iq ir it jo kg kh ki km kn kp kw kz la lb lc lk lr ls lt lv ly ma me mg mk ml mn mo mr ms mu mv mw my mz na ng nr om ph pk pl pn pr ps pt pw py qa rs rw sa sb sc sd sg sh sl so ss sx sy tj tl tm tn to tr tt tw ua ug uk vc ve vn ws ye za zm zw",
  co: "ae ag am ao at az bb bd bi bj bw bz ci cl cm cr dm gg gl gy hu id il im in io ir it je jp ke kr lc ls ma me mg mu mw mz na ni nz om pn rs rw ss st sz th tj tm tt tz ug uk us uz ve vi za zm zw",
  ac: "ae at bd be bw ci cn cr cy eg fj gn id il im in ir jp ke kr lk ls ma me ml mu mw mz ni nz pa pk pr rs rw se sz th tj tz ug uk vn za zm zw",
  mil: "ac ae al ar az ba bd bo br by cl cn co cy do ec eg fj gh gt hn id in io iq jo kg km kr kz lv mg mv my mz ng ni no nz pe ph pl py qa rw sh st sy tj tm to tr tt tw tz ug uy vc ve ye za zm zw",
  ne: "jp ke kr tz ug us",
  or: "at bi ci cr id it jp ke kr mu th tz ug us",
  go: "ci cr id it jp ke kr th tj tz ug",
  gob: "ar bo cl cu do ec es gt hn mx ni pa pe pk sv ve",
  gouv: "ci fr ht km ml sn",
  nom: "ag co es fr io km mg nc ni pa pe pl ro tm ve za",
  sch: "ae bd id ir jo lk ly ng qa sa ss zm",
  ltd: "cy gi lk uk",
  plc: "ly uk",
  info: "az bb bd bj bo ec eg et fj gu ht hu in ke ki la ls ml mv nf ni nr pl pr ro sd tn tr tt tz ve vn zm",
  biz: "az bb cy et fj gh id in ki ls mv mw my ni nr pk pl pr ss tj tr tt vn zm",
  gen: "in nz tr",
  nic: "in tj za",
  int: "ar az bo ci cv in la lk mv mw ni pt tj ve vn",
};
const PRIVATE =
  "github.io githubusercontent.com gitlab.io codeberg.page bitbucket.io readthedocs.io vercel.app now.sh netlify.app pages.dev workers.dev r2.dev trycloudflare.com cloudflare.net herokuapp.com appspot.com web.app firebaseapp.com azurewebsites.net azurestaticapps.net cloudapp.net cloudfront.net s3.amazonaws.com elasticbeanstalk.com blogspot.com ts.net ngrok.io ngrok-free.app ngrok.app ngrok.dev fly.dev onrender.com up.railway.app repl.co replit.dev replit.app deno.dev deno.net supabase.co csb.app translate.goog ondigitalocean.app pythonanywhere.com myshopify.com wixsite.com webflow.io framer.app lovable.app bolt.host streamlit.app hf.space dyndns.org duckdns.org no-ip.org ddns.net myftp.org";
const WILDCARD = "ck er fk jm mm np pg nom.br sch.uk";

/** Label trie walked TLD-first: an open-addressed edge table hashed on (parent, label). */
const MASK = 0xfff;
const EDGE_HASH = new Int32Array(MASK + 1);
const EDGE_PARENT = new Int32Array(MASK + 1);
const EDGE_CHILD = new Int32Array(MASK + 1); // 0 = empty slot; the root (0) is never a child.
const EDGE_LABEL: string[] = new Array<string>(MASK + 1).fill("");
const FLAGS = [0]; // per node: 1 = listed suffix, 2 = wildcard (any child label is one)

let hash = 0;
let dirty = false;
/** Index of the `.` before the label ending at `pos`, or -1; sets `hash` for `parent`'s edge. */
function label(host: string, pos: number, parent: number): number {
  let h = Math.imul(parent + 1, 0x9e3779b1);
  let i = pos - 1;
  for (; i >= 0; i--) {
    const c = host.charCodeAt(i);
    if (c === 46) break;
    if (c >= 65 && (c <= 90 || c > 127)) dirty = true;
    h = Math.imul(h ^ c, 0x01000193);
  }
  hash = h;
  return i;
}

/** Child of `parent` along `host[from, to)` (whose hash is `hash`), or 0. */
function child(host: string, from: number, to: number, parent: number): number {
  for (let slot = (hash ^ (hash >>> 15)) & MASK; EDGE_CHILD[slot]; slot = (slot + 1) & MASK) {
    const text = EDGE_LABEL[slot]!;
    if (
      EDGE_HASH[slot] === hash &&
      EDGE_PARENT[slot] === parent &&
      text.length === to - from &&
      host.startsWith(text, from)
    )
      return EDGE_CHILD[slot]!;
  }
  return 0;
}

function insert(suffix: string, flag: number) {
  let node = 0;
  for (let pos = suffix.length; pos > 0;) {
    const dot = label(suffix, pos, node);
    let kid = child(suffix, dot + 1, pos, node);
    if (!kid) {
      let slot = (hash ^ (hash >>> 15)) & MASK;
      while (EDGE_CHILD[slot]) slot = (slot + 1) & MASK;
      EDGE_HASH[slot] = hash;
      EDGE_PARENT[slot] = node;
      EDGE_LABEL[slot] = suffix.slice(dot + 1, pos);
      EDGE_CHILD[slot] = kid = FLAGS.push(0) - 1;
    }
    node = kid;
    pos = dot;
  }
  FLAGS[node]! |= flag;
}
let built = false;
function build() {
  built = true;
  for (const suffix of PRIVATE.split(" ")) insert(suffix, 1);
  for (const [label, tlds] of Object.entries(CCTLD_SECOND_LEVELS))
    for (const tld of tlds.split(" ")) insert(`${label}.${tld}`, 1);
  for (const suffix of WILDCARD.split(" ")) insert(suffix, 2);
  if (FLAGS.length > MASK / 2) throw new Error("publicSuffix: grow MASK");
}

/** `^\d{1,3}(\.\d{1,3}){3}$` over `host[0, end)`. */
function isIPv4(host: string, end: number): boolean {
  let dots = 0;
  let run = 0;
  for (let i = 0; i < end; i++) {
    const c = host.charCodeAt(i);
    if (c === 46) {
      if (run === 0 || ++dots > 3) return false;
      run = 0;
    } else if (c < 48 || c > 57 || ++run > 3) return false;
  }
  return dots === 3 && run > 0;
}

/** Longest listed suffix of `host` (less a trailing dot); undefined if it needs lowercasing. */
function suffixOf(host: string, lowered: boolean): string | undefined {
  const end = host.charCodeAt(host.length - 1) === 46 ? host.length - 1 : host.length;
  dirty = false;
  let start = 0;
  let node = 0;
  for (let pos = end, depth = 1; ; depth++) {
    const dot = label(host, pos, node);
    const kid = child(host, dot + 1, pos, node);
    if (depth === 1 || FLAGS[node]! & 2 || FLAGS[kid]! & 1) start = dot + 1;
    if (!kid || dot < 0) break;
    node = kid;
    pos = dot;
  }
  if (dirty && !lowered) return undefined;
  return start === 0 && end === host.length ? host : host.slice(start, end);
}

/** The public suffix (eTLD) of a hostname, or null for IP addresses and empty input. */
export function getPublicSuffix(hostname: string): string | null {
  if (!hostname) return null;
  const length = hostname.length;
  const end = hostname.charCodeAt(length - 1) === 46 ? length - 1 : length;
  if (end === 0 || hostname.charCodeAt(0) === 91 || hostname.includes(":")) return null;
  const last = hostname.charCodeAt(end - 1);
  if (last >= 48 && last <= 57 && isIPv4(hostname, end)) return null;
  if (!built) build();
  return suffixOf(hostname, false) ?? suffixOf(hostname.toLowerCase(), true)!;
}
