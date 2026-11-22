// Tailwind v4 class merging (tailwind-merge 3 semantics) plus `cx`/`cva` (clsx / class-variance-authority semantics).

// Functions (state-driven `className` props) are accepted and dropped, as clsx does.
export type ClassValue =
  | ClassValue[]
  | Record<string, unknown>
  | ((...args: never[]) => unknown)
  | string
  | number
  | bigint
  | null
  | boolean
  | undefined;

function toClass(value: ClassValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  let out = "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = item ? toClass(item) : "";
      if (s) out = out ? `${out} ${s}` : s;
    }
  } else for (const key in value) if (value[key]) out = out ? `${out} ${key}` : key;
  return out;
}

export function cx(...inputs: ClassValue[]): string {
  return toClass(inputs);
}

// One group per line: `ids=values` (prefix = id) or `id=prefix:values;prefix:values`. `.` is the bare prefix.
// `{a,b}` in the ids expands the line per item, substituting `{}` in prefixes. `%n` names a shared value list.
const LISTS = [
  "@v @a px @num",
  "@any @v @a",
  "@num @pct @vMask @aMask",
  "@frac full auto @v @a px @num",
  ". none full @tshirt @v @a",
  "center top bottom left right top-left left-top top-right right-top bottom-right right-bottom bottom-left left-bottom",
  ". @num @vLen @aLen",
  "auto @v @a px @num",
  "auto start end center stretch center-safe end-safe",
  "@num @v @a",
  "none @num @v @a",
  ". @num @v @a",
  "@frac full @v @a px @num",
  "auto hidden clip visible scroll",
  "@int auto @v @a",
  "min max fit @v @a px @num",
  "start end center between around evenly stretch baseline center-safe end-safe",
];
const GROUPS = `aspect=auto square @frac @a @v video
container=:container
container-type=@container:. normal size @v @a
container-named=:@ncq
columns=@num auto @a @v @tshirt
break-after break-before=auto avoid all avoid-page page left right column
break-inside=auto avoid avoid-page avoid-column
box-decoration=slice clone
box=border content
display=:block inline-block inline flex inline-flex table inline-table table-caption table-cell table-column table-column-group table-footer-group table-header-group table-row-group table-row flow-root grid inline-grid contents list-item hidden
sr=:sr-only
not-sr=:not-sr-only
float=right left none start end
clear=left right both none start end
isolation=:isolate isolation-auto
object-fit=object:contain cover fill none scale-down
object-position=object:%5 @v @a
overflow overflow-x overflow-y=%13
overscroll overscroll-x overscroll-y=auto contain none
position=:static fixed absolute relative sticky
inset inset-x inset-y=%3
start=inset-s:%3;start:%3
end=inset-e:%3;end:%3
inset-bs inset-be top right bottom left=%3
visibility=:visible invisible collapse
z=%14
basis=@frac full auto @tshirt @v @a px @num
flex-direction=flex:row row-reverse col col-reverse
flex-wrap=flex:nowrap wrap wrap-reverse
flex=@num @frac auto initial none @v @a
grow shrink=%11
order=@int first last none @v @a
grid-cols=@int none subgrid @v @a
col-start-end=col:auto;col-span:full @int @v @a;col:@int @v @a
col-start col-end=%14
grid-rows=@int none subgrid @v @a
row-start-end=row:auto;row-span:full @int @v @a;row:@int @v @a
row-start row-end=%14
grid-flow=row col dense row-dense col-dense
auto-cols auto-rows=auto min max fr @v @a
gap gap-x gap-y=%0
justify-content=justify:%16 normal
justify-items=start end center stretch center-safe end-safe normal
justify-self=%8
align-content=content:normal %16
align-items=items:start end center stretch center-safe end-safe;items-baseline:. last
align-self=self:%8;self-baseline:. last
place-content=%16
place-items=start end center stretch center-safe end-safe baseline
place-self=%8
p px py ps pe pbs pbe pt pr pb pl=%0
m mx my ms me mbs mbe mt mr mb ml=%7
space-x=%0
space-x-reverse=:space-x-reverse
space-y=%0
space-y-reverse=:space-y-reverse
size=@frac auto full dvw dvh lvw lvh svw svh %15
inline-size=inline:auto @tshirt @frac screen full dvw lvw svw %15
min-inline-size=min-inline:auto @tshirt @frac screen full dvw lvw svw %15
max-inline-size=max-inline:none @tshirt @frac screen full dvw lvw svw %15
block-size=block:auto @frac screen full lh dvh lvh svh %15
min-block-size=min-block:auto @frac screen full lh dvh lvh svh %15
max-block-size=max-block:none @frac screen full lh dvh lvh svh %15
w=@tshirt screen @frac auto full dvw dvh lvw lvh svw svh %15
min-w=@tshirt screen none @frac auto full dvw dvh lvw lvh svw svh %15
max-w=max-w:@tshirt screen none prose;max-w-screen:@tshirt;max-w:@frac auto full dvw dvh lvw lvh svw svh %15
h=screen lh @frac auto full dvw dvh lvw lvh svw svh %15
min-h max-h=screen lh none @frac auto full dvw dvh lvw lvh svw svh %15
font-size=text:base @tshirt @vLen @aLen
font-smoothing=:antialiased subpixel-antialiased
font-style=:italic not-italic
font-weight=font:thin extralight light normal medium semibold bold extrabold black @vWeight @aWeight
font-stretch=ultra-condensed extra-condensed condensed semi-condensed normal semi-expanded expanded extra-expanded ultra-expanded @pct @a
font-family=font:@vFam @aFam @nonarb
font-features=@a
fvn-normal=:normal-nums
fvn-ordinal=:ordinal
fvn-slashed-zero=:slashed-zero
fvn-figure=:lining-nums oldstyle-nums
fvn-spacing=:proportional-nums tabular-nums
fvn-fraction=:diagonal-fractions stacked-fractions
tracking=tighter tight normal wide wider widest @v @a
line-clamp=@num none @v @a
leading=none tight snug normal relaxed loose @v @a px @num
list-image=none @v @a
list-style-position=list:inside outside
list-style-type=list:disc decimal none @v @a
text-alignment=text:left center right justify start end
placeholder-color=placeholder:%1
text-color=text:%1
text-decoration=:underline overline line-through no-underline
text-decoration-style=decoration:solid dashed dotted double wavy
text-decoration-thickness=decoration:@num from-font auto @vLen @vPos @aLen
text-decoration-color=decoration:%1
underline-offset=@num auto @v @a
text-transform=:uppercase lowercase capitalize normal-case
text-overflow=:truncate text-ellipsis text-clip
text-wrap=text:wrap nowrap balance pretty
indent=%0
tab-size=tab:@int @v @a
vertical-align=align:baseline top middle bottom text-top text-bottom sub super @v @a
whitespace=normal nowrap pre pre-line pre-wrap break-spaces
break=normal words all keep
wrap=break-word anywhere normal
hyphens=none manual auto
content=none @v @a
bg-attachment=bg:fixed local scroll
bg-clip=border padding content text
bg-origin=border padding content
bg-position=bg:%5 @vPos @aPos;bg-position:@v @a
bg-repeat=bg:no-repeat;bg-repeat:. x y space round
bg-size=bg:auto cover contain @vSize @aSize;bg-size:@v @a
bg-image=bg:none;bg-linear-to:t tr r br b bl l tl;bg-linear:@int @v @a;bg-radial:. @v @a;bg-conic:. @int @v @a;bg:@vImg @aImg
bg-color=bg:%1
gradient-{from,via,to}-pos={}:@pct @vLen @aLen
gradient-{from,via,to}={}:%1
rounded rounded-s rounded-e rounded-t rounded-r rounded-b rounded-l rounded-ss rounded-se rounded-ee rounded-es rounded-tl rounded-tr rounded-br rounded-bl=%4
border-w{,-x,-y,-s,-e,-bs,-be,-t,-r,-b,-l}=border{}:%6
divide-x=%6
divide-x-reverse=:divide-x-reverse
divide-y=%6
divide-y-reverse=:divide-y-reverse
border-style=border:solid dashed dotted double hidden none
divide-style=divide:solid dashed dotted double hidden none
border-color{,-x,-y,-s,-e,-bs,-be,-t,-r,-b,-l}=border{}:%1
divide-color=divide:%1
outline-style=outline:solid dashed dotted double none hidden
outline-offset=%9
outline-w=outline:%6
outline-color=outline:%1
shadow=. inner none @tshirt @vShadow @aShadow
shadow-color=shadow:%1
inset-shadow=none @tshirt @vShadow @aShadow
inset-shadow-color=inset-shadow:%1
ring-w=ring:%6
ring-w-inset=:ring-inset
ring-color=ring:%1
ring-offset-w=ring-offset:@num @aLen
ring-offset-color=ring-offset:%1
inset-ring-w=inset-ring:%6
inset-ring-color=inset-ring:%1
text-shadow=none @tshirt @vShadow @aShadow
text-shadow-color=text-shadow:%1
opacity=%9
mix-blend=normal multiply screen overlay darken lighten color-dodge color-burn hard-light soft-light difference exclusion hue saturation color luminosity plus-darker plus-lighter
bg-blend=normal multiply screen overlay darken lighten color-dodge color-burn hard-light soft-light difference exclusion hue saturation color luminosity
mask-clip=mask-clip:border padding content fill stroke view;:mask-no-clip
mask-composite=mask:add subtract intersect exclude
mask-image-linear-pos=mask-linear:@num
mask-image-{linear,t,r,b,l,x,y}-from-pos=mask-{}-from:%2
mask-image-{linear,t,r,b,l,x,y}-to-pos=mask-{}-to:%2
mask-image-{linear,t,r,b,l,x,y}-from-color=mask-{}-from:%1
mask-image-{linear,t,r,b,l,x,y}-to-color=mask-{}-to:%1
mask-image-radial=mask-radial:@v @a
mask-image-{radial,conic}-from-pos=mask-{}-from:%2
mask-image-{radial,conic}-to-pos=mask-{}-to:%2
mask-image-{radial,conic}-from-color=mask-{}-from:%1
mask-image-{radial,conic}-to-color=mask-{}-to:%1
mask-image-radial-shape=mask:circle ellipse
mask-image-radial-size=mask-radial-closest:side corner;mask-radial-farthest:side corner
mask-image-radial-pos=mask-radial-at:%5
mask-image-conic-pos=mask-conic:@num
mask-mode=mask:alpha luminance match
mask-origin=border padding content fill stroke view
mask-position=mask:%5 @vPos @aPos;mask-position:@v @a
mask-repeat=mask:no-repeat;mask-repeat:. x y space round
mask-size=mask:auto cover contain @vSize @aSize;mask-size:@v @a
mask-type=alpha luminance
mask-image=mask:none @v @a
filter=. none @v @a
blur=. none @tshirt @v @a
brightness contrast=%9
drop-shadow=. none @tshirt @vShadow @aShadow
drop-shadow-color=drop-shadow:%1
grayscale=%11
hue-rotate=%9
invert=%11
saturate=%9
sepia=%11
backdrop-filter=. none @v @a
backdrop-blur=. none @tshirt @v @a
backdrop-brightness backdrop-contrast=%9
backdrop-grayscale=%11
backdrop-hue-rotate=%9
backdrop-invert=%11
backdrop-opacity backdrop-saturate=%9
backdrop-sepia=%11
border-collapse=border:collapse separate
border-spacing border-spacing-x border-spacing-y=%0
table-layout=table:auto fixed
caption=top bottom
transition=. all colors opacity shadow transform none @v @a
transition-behavior=transition:normal discrete
duration=@num initial @v @a
ease=linear initial in out in-out @v @a
delay=%9
animate=none spin ping pulse bounce @v @a
backface=hidden visible
perspective=dramatic near normal midrange distant none @v @a
perspective-origin=%5 @v @a
rotate rotate-x rotate-y rotate-z scale scale-x scale-y scale-z=%10
scale-3d=:scale-3d
skew skew-x skew-y=%9
transform=@v @a . none gpu cpu
transform-origin=origin:%5 @v @a
transform-style=transform:3d flat
translate translate-x translate-y translate-z=%12
translate-none=:translate-none
zoom=@int @v @a
accent=%1
appearance=none auto
caret-color=caret:%1
color-scheme=scheme:normal dark light light-dark only-dark only-light
cursor=auto default pointer wait text move help not-allowed none context-menu progress cell crosshair vertical-text alias copy no-drop grab grabbing all-scroll col-resize row-resize n-resize e-resize s-resize w-resize ne-resize nw-resize se-resize sw-resize ew-resize ns-resize nesw-resize nwse-resize zoom-in zoom-out @v @a
field-sizing=fixed content
pointer-events=auto none
resize=none . y x
scroll-behavior=scroll:auto smooth
scrollbar-thumb-color=scrollbar-thumb:%1
scrollbar-track-color=scrollbar-track:%1
scrollbar-gutter=auto stable both
scrollbar-w=scrollbar:auto thin none
scroll-m scroll-mx scroll-my scroll-ms scroll-me scroll-mbs scroll-mbe scroll-mt scroll-mr scroll-mb scroll-ml scroll-p scroll-px scroll-py scroll-ps scroll-pe scroll-pbs scroll-pbe scroll-pt scroll-pr scroll-pb scroll-pl=%0
snap-align=snap:start end center align-none
snap-stop=snap:normal always
snap-type=snap:none x y both
snap-strictness=snap:mandatory proximity
touch=auto none manipulation
touch-x=touch-pan:x left right
touch-y=touch-pan:y up down
touch-pz=:touch-pinch-zoom
select=none text all auto
will-change=auto scroll contents transform @v @a
fill=none @any @v @a
stroke-w=stroke:@num @vLen @aLen @aNum
stroke=none @any @v @a
forced-color-adjust=auto none`;

// Later groups listed after `:` lose to an earlier-listed group of that line; `{a,b}` expands like GROUPS.
const CONFLICTS = `container-named:container-type
overflow:overflow-x overflow-y
overscroll:overscroll-x overscroll-y
inset:inset-x inset-y inset-bs inset-be start end top right bottom left
inset-x:start end right left
inset-y:inset-bs inset-be top bottom
flex:basis grow shrink
gap:gap-x gap-y
place-{content,items,self}:align-{} justify-{}
p:px py ps pe pbs pbe pt pr pb pl
px:ps pe pr pl
py:pbs pbe pt pb
m:mx my ms me mbs mbe mt mr mb ml
mx:ms me mr ml
my:mbs mbe mt mb
size:w h
fvn-normal:fvn-ordinal fvn-slashed-zero fvn-figure fvn-spacing fvn-fraction
fvn-{ordinal,slashed-zero,figure,spacing,fraction}:fvn-normal
line-clamp:display overflow
sr:not-sr position size w h p px py ps pe pbs pbe pt pr pb pl m mx my ms me mbs mbe mt mr mb ml overflow overflow-x overflow-y whitespace
not-sr:sr
rounded:rounded-s rounded-e rounded-t rounded-r rounded-b rounded-l rounded-ss rounded-se rounded-ee rounded-es rounded-tl rounded-tr rounded-br rounded-bl
rounded-s:rounded-ss rounded-es
rounded-e:rounded-se rounded-ee
rounded-t:rounded-tl rounded-tr
rounded-r:rounded-tr rounded-br
rounded-b:rounded-br rounded-bl
rounded-l:rounded-tl rounded-bl
border-spacing:border-spacing-x border-spacing-y
border-{w,color}:border-{}-x border-{}-y border-{}-s border-{}-e border-{}-bs border-{}-be border-{}-t border-{}-r border-{}-b border-{}-l
border-{w,color}-x:border-{}-s border-{}-e border-{}-r border-{}-l
border-{w,color}-y:border-{}-bs border-{}-be border-{}-t border-{}-b
mask-image-x-{from-pos,to-pos,from-color,to-color}:mask-image-r-{} mask-image-l-{}
mask-image-y-{from-pos,to-pos,from-color,to-color}:mask-image-t-{} mask-image-b-{}
translate:translate-x translate-y translate-none
translate-none:translate translate-x translate-y translate-z
scroll-m:scroll-mx scroll-my scroll-ms scroll-me scroll-mbs scroll-mbe scroll-mt scroll-mr scroll-mb scroll-ml
scroll-mx:scroll-ms scroll-me scroll-mr scroll-ml
scroll-my:scroll-mbs scroll-mbe scroll-mt scroll-mb
scroll-p:scroll-px scroll-py scroll-ps scroll-pe scroll-pbs scroll-pbe scroll-pt scroll-pr scroll-pb scroll-pl
scroll-px:scroll-ps scroll-pe scroll-pr scroll-pl
scroll-py:scroll-pbs scroll-pbe scroll-pt scroll-pb
touch:touch-x touch-y touch-pz
touch-{x,y,pz}:touch`;
// Conflicts that apply only when the class has a postfix modifier (`text-sm/6` also sets line height).
const POSTFIX_CONFLICTS: Record<string, readonly string[]> = { "font-size": ["leading"] };
// Groups whose classes may themselves contain `/` (`@container/name`).
const POSTFIX_LOOKUP = new Set(["container-type"]);
const ORDER_SENSITIVE = new Set(["*", "**", "after", "backdrop", "before", "details-content", "file", "first-letter", "first-line", "marker", "placeholder", "selection"]);

const ARBITRARY_VALUE = /^\[(?:(\w[\w-]*):)?(.+)\]$/i;
const ARBITRARY_VARIABLE = /^\((?:(\w[\w-]*):)?(.+)\)$/i;
const LENGTH = /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|Q|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^--spacing\(.+\)|^0$/;
const COLOR_FUNCTION = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix|color|light-dark|contrast-color|device-cmyk|--alpha)\(.+\)$/i;
const MASK_POSITION = /^(?:_*[+-]?(?:\d|\.\d)|[\w-]+\(|_*(?:inherit|initial|revert(?:-layer)?|unset)_*$)/i;
const SHADOW = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/;
const IMAGE = /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/;

type Test = (value: string) => boolean;
const isNumber: Test = (v) => !!v && !Number.isNaN(Number(v));
const never: Test = () => false;
const arbitrary = (label: Test, value: Test): Test => (v) => {
  const m = ARBITRARY_VALUE.exec(v);
  return m ? (m[1] ? label(m[1]) : value(m[2]!)) : false;
};
const variable = (label: Test, unlabeled = false): Test => (v) => {
  const m = ARBITRARY_VARIABLE.exec(v);
  return m ? (m[1] ? label(m[1]) : unlabeled) : false;
};
const is = (...labels: string[]): Test => (l) => labels.includes(l);
const TESTS: Record<string, Test> = {
  num: isNumber,
  int: (v) => !!v && Number.isInteger(Number(v)),
  frac: (v) => /^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/.test(v),
  pct: (v) => v.endsWith("%") && isNumber(v.slice(0, -1)),
  tshirt: (v) => /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/.test(v),
  any: () => true,
  nonarb: (v) => !ARBITRARY_VALUE.test(v) && !ARBITRARY_VARIABLE.test(v),
  ncq: (v) =>
    v.startsWith("@container") &&
    ((v[10] === "/" && v[11] !== undefined) || (v[11] === "s" && v[16] !== undefined && v.startsWith("-size/", 10)) || (v[11] === "n" && v[18] !== undefined && v.startsWith("-normal/", 10))),
  a: (v) => ARBITRARY_VALUE.test(v),
  v: (v) => ARBITRARY_VARIABLE.test(v),
  aLen: arbitrary(is("length"), (v) => LENGTH.test(v) && !COLOR_FUNCTION.test(v)),
  vLen: variable(is("length")),
  aSize: arbitrary(is("length", "size", "bg-size"), never),
  vSize: variable(is("length", "size", "bg-size")),
  aPos: arbitrary(is("position", "percentage"), never),
  vPos: variable(is("position", "percentage")),
  aImg: arbitrary(is("image", "url"), (v) => IMAGE.test(v)),
  vImg: variable(is("image", "url")),
  aShadow: arbitrary(is("shadow"), (v) => SHADOW.test(v)),
  vShadow: variable(is("shadow"), true),
  aWeight: arbitrary(is("number", "weight"), () => true),
  vWeight: variable(is("number", "weight"), true),
  aFam: arbitrary(is("family-name"), never),
  vFam: variable(is("family-name")),
  aNum: arbitrary(is("number"), isNumber),
  aMask: arbitrary((l) => l !== "color", (v) => MASK_POSITION.test(v) && !COLOR_FUNCTION.test(v)),
  vMask: variable((l) => l !== "color", true),
};

/** Expands `{a,b}` in `head`, substituting each item for `{}` in `tail`. */
function expand(head: string, tail: string): Array<[string, string]> {
  const m = /\{([^}]*)\}/.exec(head);
  if (!m) return [[head, tail]];
  return m[1]!.split(",").map((item) => [head.replace(m[0], item), tail.replaceAll("{}", item)]);
}

interface Registry {
  readonly exact: Map<string, string>;
  readonly tests: Map<string, Array<readonly [Test, string]>>;
  readonly conflicts: Map<string, readonly string[]>;
}

function buildRegistry(groups: string): Registry {
  const exact = new Map<string, string>();
  const tests = new Map<string, Array<readonly [Test, string]>>();
  const add = (group: string, prefix: string, values: string) => {
    for (const token of values.replace(/%(\d+)/g, (_, i: string) => LISTS[Number(i)]!).split(" ")) {
      if (token[0] === "@") {
        const list = tests.get(prefix) ?? tests.set(prefix, []).get(prefix)!;
        list.push([TESTS[token.slice(1)]!, group]);
      } else exact.set(token === "." ? prefix : prefix ? `${prefix}-${token}` : token, group);
    }
  };
  for (const line of groups.split("\n")) {
    const eq = line.indexOf("=");
    for (const [ids, body] of expand(line.slice(0, eq), line.slice(eq + 1))) {
      for (const id of ids.split(" ")) {
        for (const seg of body.split(";")) {
          const colon = seg.indexOf(":");
          if (colon < 0) add(id, id, seg);
          else add(id, seg.slice(0, colon), seg.slice(colon + 1));
        }
      }
    }
  }
  const conflicts = new Map<string, readonly string[]>();
  for (const line of CONFLICTS.split("\n")) {
    const colon = line.indexOf(":");
    for (const [id, list] of expand(line.slice(0, colon), line.slice(colon + 1))) conflicts.set(id, list.split(" "));
  }
  return { exact, tests, conflicts };
}

function groupOf({ exact, tests }: Registry, className: string): string | undefined {
  if (className[0] === "[" && className.endsWith("]")) {
    const colon = className.indexOf(":");
    return colon > 1 && colon < className.length - 1 ? `arbitrary..${className.slice(1, colon)}` : undefined;
  }
  const base = className[0] === "-" && className.length > 1 ? className.slice(1) : className;
  const hit = exact.get(base);
  if (hit) return hit;
  for (let i = base.lastIndexOf("-"); i > 0; i = base.lastIndexOf("-", i - 1)) {
    const list = tests.get(base.slice(0, i));
    if (!list) continue;
    const rest = base.slice(i + 1);
    for (const [test, group] of list) if (test(rest)) return group;
  }
  for (const [test, group] of tests.get("") ?? []) if (test(base)) return group;
  return undefined;
}

function sortModifiers(modifiers: string[]): string {
  const out: string[] = [];
  let run: string[] = [];
  for (const m of modifiers) {
    if (m[0] === "[" || ORDER_SENSITIVE.has(m)) {
      out.push(...run.sort(), m);
      run = [];
    } else run.push(m);
  }
  return [...out, ...run.sort()].join(":");
}

interface ClassInfo { readonly id: string; readonly conflicts: readonly string[] }

function classInfo(registry: Registry, className: string): ClassInfo | null {
  const modifiers: string[] = [];
  let depthBracket = 0;
  let depthParen = 0;
  let start = 0;
  let postfix = -1;
  for (let i = 0; i < className.length; i++) {
    const c = className[i];
    if (depthBracket === 0 && depthParen === 0) {
      if (c === ":") {
        modifiers.push(className.slice(start, i));
        start = i + 1;
        continue;
      }
      if (c === "/") {
        postfix = i;
        continue;
      }
    }
    if (c === "[") depthBracket++;
    else if (c === "]") depthBracket--;
    else if (c === "(") depthParen++;
    else if (c === ")") depthParen--;
    else if (c === "\\") i++;
    else if (c === '"' || c === "'") {
      while (++i < className.length && className[i] !== c) if (className[i] === "\\") i++;
    }
  }
  let base = className.slice(start);
  let important = false;
  let shift = 0;
  if (base.endsWith("!")) {
    base = base.slice(0, -1);
    important = true;
  } else if (base[0] === "!") {
    base = base.slice(1);
    important = true;
    shift = 1;
  }
  const at = postfix > start ? postfix - start - shift : 0;
  let hasPostfix = at > 0;
  let group: string | undefined;
  if (hasPostfix) {
    group = groupOf(registry, base.slice(0, at));
    const whole = group && POSTFIX_LOOKUP.has(group) ? groupOf(registry, base) : undefined;
    if (whole && whole !== group) {
      group = whole;
      hasPostfix = false;
    }
  } else group = groupOf(registry, base);
  if (!group) {
    if (!hasPostfix || !(group = groupOf(registry, base))) return null;
    hasPostfix = false;
  }
  const variant = modifiers.length === 0 ? "" : modifiers.length === 1 ? modifiers[0]! : sortModifiers(modifiers);
  const prefix = important ? `${variant}!` : variant;
  const conflicts = registry.conflicts.get(group) ?? [];
  const extra = hasPostfix ? POSTFIX_CONFLICTS[group] : undefined;
  const all = extra ? [...conflicts, ...extra] : conflicts;
  return { id: prefix + group, conflicts: all.map((c) => prefix + c) };
}

/** Flat memo that starts over when full; class vocabularies are small, so it refills almost entirely with hits. */
function boundedCache<V>(size: number) {
  const map = new Map<string, V>();
  return {
    get: (key: string) => map.get(key),
    set(key: string, value: V) {
      if (map.size >= size) map.clear();
      map.set(key, value);
    },
  };
}

const OTHER_SPACE = /[^\S ]/;

/** `extraGroups` uses the GROUPS line format; lines for an existing group add to it. */
export function createTwMerge(extraGroups = ""): (...inputs: ClassValue[]) => string {
  const registry = buildRegistry(extraGroups ? `${GROUPS}\n${extraGroups}` : GROUPS);
  // Conflict keys are interned to ints so a merge marks them in a stamped array without allocating.
  const keys = new Map<string, number>();
  const intern = (key: string) => keys.get(key) ?? keys.set(key, keys.size).size - 1;
  let stamps = new Int32Array(1024);
  let epoch = 0;
  const infos = boundedCache<{ readonly id: number; readonly conflicts: readonly number[] } | null>(4096);
  const results = boundedCache<string>(1024);
  const info = (className: string) => {
    let hit = infos.get(className);
    if (hit === undefined) {
      const meta = classInfo(registry, className);
      hit = meta && { id: intern(meta.id), conflicts: meta.conflicts.map(intern) };
      infos.set(className, hit);
      if (keys.size > stamps.length) {
        const grown = new Int32Array(keys.size * 2);
        grown.set(stamps);
        stamps = grown;
      }
    }
    return hit;
  };
  const merge = (classList: string): string => {
    const cached = results.get(classList);
    if (cached !== undefined) return cached;
    if (++epoch === 0x7fffffff) {
      stamps.fill(0);
      epoch = 1;
    }
    const classes = OTHER_SPACE.test(classList) ? classList.trim().split(/\s+/) : classList.split(" ");
    let out = "";
    for (let i = classes.length - 1; i >= 0; i--) {
      const className = classes[i]!;
      if (!className) continue;
      const meta = info(className);
      if (meta) {
        if (stamps[meta.id] === epoch) continue;
        stamps[meta.id] = epoch;
        for (const c of meta.conflicts) stamps[c] = epoch;
      }
      out = out ? `${className} ${out}` : className;
    }
    results.set(classList, out);
    return out;
  };
  return (...inputs) => merge(inputs.length === 1 && typeof inputs[0] === "string" ? inputs[0] : toClass(inputs));
}

export const twMerge = createTwMerge();

type StringToBoolean<T> = T extends "true" | "false" ? boolean : T;
type VariantSchema = Record<string, Record<string, ClassValue>>;
type VariantSelection<T extends VariantSchema> = { [K in keyof T]?: StringToBoolean<keyof T[K]> | null | undefined };
type ClassProp = { class?: ClassValue; className?: ClassValue };
interface CvaConfig<T extends VariantSchema> {
  variants?: T;
  defaultVariants?: VariantSelection<T>;
  compoundVariants?: Array<{ [K in keyof T]?: StringToBoolean<keyof T[K]> | Array<StringToBoolean<keyof T[K]>> } & ClassProp>;
}
export type VariantProps<C extends (...args: never[]) => unknown> = Omit<NonNullable<Parameters<C>[0]>, "class" | "className">;

const variantKey = (v: unknown) => (typeof v === "boolean" ? `${v}` : v === 0 ? "0" : v);

export function cva<T extends VariantSchema>(base?: ClassValue, config?: CvaConfig<T>) {
  return (props?: VariantSelection<T> & ClassProp): string => {
    const variants = config?.variants;
    if (variants == null) return cx(base, props?.class, props?.className);
    const defaults: Record<string, unknown> = config?.defaultVariants ?? {};
    const given: Record<string, unknown> = props ?? {};
    const picked = Object.keys(variants).map((name) => {
      if (given[name] === null) return null;
      const key = (variantKey(given[name]) || variantKey(defaults[name])) as string;
      return variants[name]![key];
    });
    const selection: Record<string, unknown> = { ...defaults };
    for (const k in given) if (given[k] !== undefined) selection[k] = given[k];
    const compound: ClassValue[] = [];
    for (const { class: cls, className, ...when } of config?.compoundVariants ?? []) {
      const match = Object.entries(when).every(([k, v]) => (Array.isArray(v) ? v.includes(selection[k]) : selection[k] === v));
      if (match) compound.push(cls, className);
    }
    return cx(base, picked, compound, props?.class, props?.className);
  };
}
