import {
  ClikeLexer,
  escapeEnd,
  type DynamicDelimiter,
  type LangSpec,
  type StringRule,
} from "./clike.ts";
import { lexerNameFor } from "./languages.ts";
import { type Lexer } from "./lexer.ts";
import { CssLexer, MarkupLexer } from "./markup.ts";
import {
  csvLexer,
  diffLexer,
  DockerfileLexer,
  IniLexer,
  MakefileLexer,
  MarkdownLexer,
  plainLexer,
  ShellLexer,
  TomlLexer,
  YamlLexer,
} from "./text.ts";
import { T } from "./tokens.ts";

const DQ: StringRule = { open: '"' };
const SQ: StringRule = { open: "'" };
const C_COMMENTS = {
  lineComment: ["//"],
  blockComment: [["/*", "*/"]] as const,
  docComment: ["/**", "///"],
};

/** `r#"…"#` and `br"…"`. */
function rustRaw(line: string, at: number): DynamicDelimiter | null {
  let i = at;
  if (line[i] === "b") i++;
  if (line[i] !== "r") return null;
  if (i > 0 && /\w/u.test(line[at - 1] ?? "")) return null;
  i++;
  const hashesStart = i;
  while (line[i] === "#") i++;
  if (line[i] !== '"') return null;
  return { length: i + 1 - at, close: `"${"#".repeat(i - hashesStart)}` };
}

/** C++ `R"delim(…)delim"`, with optional encoding prefixes. */
function cppRaw(line: string, at: number): DynamicDelimiter | null {
  const match = /^(?:u8|[uUL])?R"([^()\\\s]{0,16})\(/u.exec(line.slice(at, at + 24));
  if (!match || (at > 0 && /\w/u.test(line[at - 1]!))) return null;
  return { length: match[0].length, close: `)${match[1]}"` };
}

/** Lua `[[…]]` / `[==[…]==]`, optionally after `--` for comments. */
function luaLong(comment: boolean) {
  return (line: string, at: number): DynamicDelimiter | null => {
    let i = at;
    if (comment) {
      if (!line.startsWith("--", at)) return null;
      i += 2;
    }
    if (line[i] !== "[") return null;
    let level = 0;
    while (line[i + 1 + level] === "=") level++;
    if (line[i + 1 + level] !== "[") return null;
    const equals = "=".repeat(level);
    return { length: i + 2 + level - at, close: `]${equals}]` };
  };
}

const JS_WORDS: NonNullable<LangSpec["words"]> = {
  keywordDeclaration: "const let var function class interface type enum namespace module declare",
  keywordImport: "import export from",
  keywordControl:
    "if else for while do switch case default break continue return throw try catch finally yield await with",
  keyword:
    "new delete in of void async static public private protected readonly abstract extends implements get set as is asserts satisfies override accessor infer unique",
  keywordOperator: "typeof instanceof keyof",
  typeBuiltin: "string number boolean any unknown never object symbol bigint",
  boolean: "true false",
  constantBuiltin: "null undefined NaN Infinity",
  variableSpecial: "this super arguments globalThis",
};

function js(name: string, jsx: boolean): LangSpec {
  return {
    name,
    ...C_COMMENTS,
    strings: [{ open: "`", multiline: true, interp: "${" }, DQ, SQ],
    words: JS_WORDS,
    identChars: "$",
    functionDecl: "function",
    typeDecl: "class interface enum type namespace",
    regex: true,
    jsx,
    annotation: true,
  };
}

const C_WORDS = {
  keyword:
    "auto extern register static inline volatile const restrict sizeof _Alignas _Alignof _Atomic _Noreturn _Static_assert _Thread_local",
  keywordDeclaration: "struct union enum typedef",
  keywordControl: "if else for while do switch case default break continue return goto",
  typeBuiltin:
    "void char short int long float double signed unsigned bool _Bool size_t ssize_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t intptr_t uintptr_t wchar_t FILE",
  boolean: "true false",
  constantBuiltin: "NULL nullptr",
};

function cFamily(
  name: string,
  extra: Partial<Record<keyof typeof C_WORDS | "variableSpecial", string>> = {},
  cpp = false,
): LangSpec {
  const words: Record<string, string> = { ...C_WORDS };
  for (const [key, value] of Object.entries(extra)) words[key] = `${words[key] ?? ""} ${value}`;
  return {
    name,
    ...C_COMMENTS,
    strings: [
      { open: '"', prefixes: "LuU8@" },
      { open: "'", prefixes: "LuU" },
    ],
    ...(cpp ? { rawString: cppRaw, rawStarts: "RuUL", namespaceDecl: "namespace" } : {}),
    arrowMember: true,
    words,
    preprocessor: true,
    pathSep: cpp,
    annotation: name === "objc",
    typeDecl: cpp ? "class struct union enum" : "struct union enum",
  };
}

const CPP_EXTRA = {
  keyword:
    "class namespace template typename public private protected virtual override final friend explicit mutable constexpr consteval constinit noexcept operator new delete using decltype static_cast dynamic_cast reinterpret_cast const_cast co_await co_return co_yield concept requires export import module try catch throw alignas alignof",
  typeBuiltin: "auto char8_t char16_t char32_t",
  variableSpecial: "this",
};

const LISP_WORDS: NonNullable<LangSpec["words"]> = {
  keywordDeclaration:
    "def defn defn- defmacro defprotocol defrecord deftype defmulti defmethod defonce ns define define-syntax lambda defun defvar defparameter defconst defclass defstruct defgeneric",
  keywordControl:
    "if when unless cond case do recur throw try catch finally and or not begin let let* letrec loop fn quote",
  boolean: "true false #t #f",
  constantBuiltin: "nil null",
};

const SHADER_WORDS: NonNullable<LangSpec["words"]> = {
  keywordDeclaration: "fn let var const struct alias override cbuffer typedef",
  keyword:
    "uniform in out inout layout attribute varying precision highp mediump lowp flat smooth centroid invariant discard static groupshared register shared buffer readonly writeonly",
  keywordControl: "return break continue if else for while do switch case default loop",
  typeBuiltin:
    "void bool int uint float double vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4 mat2 mat3 mat4 mat2x2 mat3x3 mat4x4 sampler2D samplerCube sampler3D f32 i32 u32 f16 vec2f vec3f vec4f mat4x4f array ptr atomic texture_2d sampler float2 float3 float4 float3x3 float4x4 half half2 half3 half4 int2 int3 int4 Texture2D SamplerState RWTexture2D StructuredBuffer",
  boolean: "true false",
};

/** Declarative grammars for languages that fit the C-like model. */
const SPECS: Readonly<Record<string, LangSpec>> = {
  typescript: js("typescript", false),
  tsx: js("tsx", true),
  javascript: js("javascript", true),
  jsx: js("jsx", true),
  python: {
    name: "python",
    lineComment: ["#"],
    strings: ['"""', "'''", '"', "'"].map((open) => ({
      open,
      multiline: open.length === 3,
      prefixes: "rRbBuUfFtT",
      interpPrefix: "fFtT",
      interp: "{",
    })),
    words: {
      keywordDeclaration: "def class lambda global nonlocal",
      keywordImport: "import from as",
      keywordControl:
        "if elif else for while break continue return try except finally raise with yield pass match case await async assert del",
      keywordOperator: "and or not in is",
      boolean: "True False",
      constantBuiltin: "None NotImplemented Ellipsis __name__ __file__",
      variableSpecial: "self cls",
      typeBuiltin:
        "int float str bool bytes list dict set tuple object complex frozenset bytearray type",
    },
    functionDecl: "def",
    typeDecl: "class",
    annotation: true,
  },
  rust: {
    name: "rust",
    ...C_COMMENTS,
    docComment: ["///", "//!", "/**", "/*!"],
    nestedComments: true,
    strings: [
      { open: '"', multiline: true, prefixes: "b" },
      { open: "'", prefixes: "b" },
    ],
    rawString: rustRaw,
    rawStarts: "rb",
    namespaceDecl: "mod",
    words: {
      keywordDeclaration: "fn let const static struct enum trait impl type mod union macro_rules",
      keyword: "pub crate where as dyn move ref mut unsafe extern async await",
      keywordImport: "use",
      keywordControl: "if else match for while loop break continue return in yield",
      typeBuiltin: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str",
      boolean: "true false",
      variableSpecial: "self Self super",
    },
    functionDecl: "fn",
    typeDecl: "struct enum trait type union",
    macroBang: true,
    lifetimes: true,
    hashAttribute: true,
    pathSep: true,
  },
  go: {
    name: "go",
    ...C_COMMENTS,
    strings: [DQ, { open: "`", multiline: true, escape: false }, SQ],
    words: {
      keywordDeclaration: "func var const type package struct interface map chan",
      keywordImport: "import",
      keywordControl:
        "if else for range switch case default break continue return go defer select goto fallthrough",
      typeBuiltin:
        "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any",
      boolean: "true false",
      constantBuiltin: "nil iota",
    },
    functionDecl: "func",
    typeDecl: "type",
    namespaceDecl: "package",
    nameFirstParams: true,
  },
  c: cFamily("c"),
  cpp: cFamily("cpp", CPP_EXTRA, true),
  objc: cFamily(
    "objc",
    {
      ...CPP_EXTRA,
      keyword: `${CPP_EXTRA.keyword} id instancetype nonatomic atomic strong weak copy assign`,
      variableSpecial: "self super",
    },
    true,
  ),
  cuda: cFamily(
    "cuda",
    {
      ...CPP_EXTRA,
      keyword: `${CPP_EXTRA.keyword} __global__ __device__ __host__ __shared__ __constant__ __restrict__`,
      variableSpecial: "this threadIdx blockIdx blockDim gridDim warpSize",
    },
    true,
  ),
  csharp: {
    name: "csharp",
    ...C_COMMENTS,
    strings: [
      { open: '"""', multiline: true, prefixes: "$@", interpPrefix: "$", interp: "{" },
      { open: '"', prefixes: "$@", interpPrefix: "$", interp: "{" },
      SQ,
    ],
    words: {
      keyword:
        "abstract as base checked delegate event explicit extern fixed implicit internal is lock new operator out override params private protected public readonly ref sealed sizeof stackalloc static unchecked unsafe virtual volatile async await get set init value where yield partial required global",
      keywordDeclaration: "class struct interface enum namespace var const record",
      keywordImport: "using",
      keywordControl:
        "if else for foreach in while do switch case default break continue return throw try catch finally goto when",
      typeBuiltin:
        "bool byte sbyte char decimal double float int uint long ulong short ushort object string void dynamic nint nuint",
      boolean: "true false",
      constantBuiltin: "null",
      variableSpecial: "this base",
    },
    typeDecl: "class struct interface enum record",
    namespaceDecl: "namespace",
    preprocessor: true,
  },
  java: {
    name: "java",
    ...C_COMMENTS,
    strings: [{ open: '"""', multiline: true }, DQ, SQ],
    words: {
      keyword:
        "abstract assert extends final implements native new private protected public static strictfp synchronized throws transient volatile permits sealed non-sealed var yield default",
      keywordOperator: "instanceof",
      keywordDeclaration: "class interface enum record",
      keywordImport: "import package",
      keywordControl:
        "if else for while do switch case break continue return throw try catch finally",
      typeBuiltin: "boolean byte char double float int long short void",
      boolean: "true false",
      constantBuiltin: "null",
      variableSpecial: "this super",
    },
    typeDecl: "class interface enum record",
    namespaceDecl: "package",
    annotation: true,
  },
  kotlin: {
    name: "kotlin",
    ...C_COMMENTS,
    nestedComments: true,
    strings: [
      { open: '"""', multiline: true, interp: "${", vars: true, escape: false },
      { open: '"', interp: "${", vars: true },
      SQ,
    ],
    words: {
      keywordDeclaration: "fun val var class interface object typealias enum",
      keyword:
        "abstract open override private public protected internal data sealed inner companion lateinit const suspend inline infix operator tailrec vararg reified crossinline noinline actual expect annotation by get set init constructor where out is as value",
      keywordImport: "import package",
      keywordControl: "if else when for while do break continue return throw try catch finally in",
      typeBuiltin: "Int Long Short Byte Double Float Boolean Char String Unit Any Nothing",
      boolean: "true false",
      constantBuiltin: "null",
      variableSpecial: "this super it",
    },
    functionDecl: "fun",
    typeDecl: "class interface object typealias",
    annotation: true,
  },
  swift: {
    name: "swift",
    ...C_COMMENTS,
    nestedComments: true,
    strings: [
      { open: '"""', multiline: true, interp: "\\(" },
      { open: '"', interp: "\\(" },
    ],
    words: {
      keywordDeclaration:
        "func var let class struct enum protocol extension typealias init deinit subscript associatedtype actor operator",
      keyword:
        "public private fileprivate internal open static final override mutating nonmutating lazy weak unowned convenience required dynamic indirect some any inout throws rethrows async await where as is get set willSet didSet",
      keywordImport: "import",
      keywordControl:
        "if else guard switch case default for in while repeat break continue fallthrough return throw try catch defer do",
      typeBuiltin:
        "Int Int8 Int16 Int32 Int64 UInt UInt8 UInt16 UInt32 UInt64 Double Float Bool String Character Void Any AnyObject",
      boolean: "true false",
      constantBuiltin: "nil",
      variableSpecial: "self Self super",
    },
    functionDecl: "func",
    typeDecl: "class struct enum protocol extension actor typealias",
    annotation: true,
    preprocessor: true,
  },
  powershell: {
    name: "powershell",
    lineComment: ["#"],
    blockComment: [["<#", "#>"]],
    strings: [
      { open: '@"', close: '"@', multiline: true, vars: true, escape: false },
      { open: "@'", close: "'@", multiline: true, escape: false },
      { open: '"', multiline: true, vars: true, interp: "$(", escape: false },
      { open: "'", multiline: true, escape: false, doubled: true },
    ],
    caseInsensitive: true,
    sigils: "$",
    identChars: "-",
    words: {
      keywordControl:
        "if elseif else switch for foreach while do until break continue return throw try catch finally trap exit in",
      keywordDeclaration: "function filter param class enum begin process end dynamicparam",
      keywordOperator:
        "-eq -ne -gt -ge -lt -le -like -notlike -match -notmatch -contains -notcontains -in -notin -and -or -not -xor -is -isnot -as -replace -split -join -f",
      boolean: "$true $false",
      constantBuiltin: "$null",
      variableSpecial: "$this $_ $psitem",
    },
    functionDecl: "function filter",
    typeDecl: "class enum",
    constantCase: false,
  },
  graphql: {
    name: "graphql",
    lineComment: ["#"],
    strings: [{ open: '"""', multiline: true }, DQ],
    words: {
      keywordDeclaration:
        "type interface enum union input scalar schema extend directive fragment query mutation subscription",
      keyword: "implements on repeatable",
      typeBuiltin: "Int Float String Boolean ID",
      boolean: "true false",
      constantBuiltin: "null",
    },
    sigils: "$",
    annotation: true,
    typeDecl: "type interface enum union input scalar fragment",
  },
  ruby: {
    name: "ruby",
    lineComment: ["#"],
    blockComment: [["=begin", "=end"]],
    strings: [
      { open: '"', multiline: true, interp: "#{" },
      { open: "'", multiline: true },
      { open: "`", multiline: true, interp: "#{" },
    ],
    words: {
      keywordDeclaration: "def class module alias undef",
      keywordControl:
        "if elsif else unless case when while until for in do end begin rescue ensure retry redo next break return yield then",
      keyword:
        "and or not defined? private protected public attr_accessor attr_reader attr_writer lambda proc loop raise",
      keywordImport: "require require_relative include extend",
      boolean: "true false",
      constantBuiltin: "nil",
      variableSpecial: "self super __method__",
    },
    identPart: "?!",
    sigils: "@$",
    symbols: true,
    regex: true,
    heredoc: "ruby",
    functionDecl: "def",
    typeDecl: "class module",
  },
  php: {
    name: "php",
    ...C_COMMENTS,
    lineComment: ["//", "#"],
    markers: ["<?php", "<?=", "?>"],
    strings: [
      { open: '"', multiline: true, vars: true, interp: "{$" },
      { open: "'", multiline: true },
    ],
    sigils: "$",
    heredoc: "php",
    arrowMember: true,
    namespaceDecl: "namespace",
    words: {
      keywordDeclaration: "function class interface trait enum namespace const fn var",
      keywordImport: "use require require_once include include_once",
      keywordControl:
        "if else elseif endif for foreach endforeach while endwhile do switch case default break continue return throw try catch finally match yield goto as",
      keyword:
        "abstract extends implements final public private protected static new clone instanceof insteadof readonly global echo print isset unset empty list array declare",
      boolean: "true false TRUE FALSE",
      constantBuiltin: "null NULL",
      variableSpecial: "$this self parent",
      typeBuiltin: "int float string bool object mixed void never iterable callable",
    },
    functionDecl: "function fn",
    typeDecl: "class interface trait enum",
    annotation: false,
  },
  lua: {
    name: "lua",
    lineComment: ["--"],
    rawComment: luaLong(true),
    rawString: luaLong(false),
    rawStarts: "[-",
    strings: [DQ, SQ],
    words: {
      keywordDeclaration: "function local type export",
      keywordControl:
        "if then else elseif end for in while do repeat until break return goto continue",
      keywordOperator: "and or not",
      boolean: "true false",
      constantBuiltin: "nil",
      variableSpecial: "self",
    },
    functionDecl: "function",
    capitalTypes: false,
  },
  sql: {
    name: "sql",
    lineComment: ["--"],
    blockComment: [["/*", "*/"]],
    strings: [
      { open: "'", doubled: true, escape: false, multiline: true },
      { open: '"', doubled: true, escape: false },
      { open: "`", escape: false },
    ],
    caseInsensitive: true,
    words: {
      keyword:
        "select from where as join inner left right outer full cross natural on using group by order having limit offset fetch insert into values update set delete create alter drop truncate table view index trigger procedure function database schema primary key foreign references unique default check constraint distinct union all except intersect case when then else end exists asc desc with recursive returning begin commit rollback transaction grant revoke if replace cascade column add rename to over partition window materialized temporary temp declare return returns language",
      keywordOperator: "and or not in is like ilike between",
      typeBuiltin:
        "int integer bigint smallint tinyint decimal numeric real float double precision varchar char character text boolean bool date time timestamp timestamptz interval json jsonb uuid blob bytea serial bigserial",
      boolean: "true false",
      constantBuiltin: "null",
    },
    sigils: "@",
    capitalTypes: false,
    constantCase: false,
  },
  json: {
    name: "json",
    ...C_COMMENTS,
    strings: [DQ, SQ],
    words: { boolean: "true false", constantBuiltin: "null NaN Infinity" },
    jsonKeys: true,
    capitalTypes: false,
    constantCase: false,
  },
  asm: {
    name: "asm",
    lineComment: [";", "#", "//", "@"],
    blockComment: [["/*", "*/"]],
    strings: [DQ, SQ],
    identChars: ".%$",
    caseInsensitive: true,
    head: "keyword",
    words: {
      variableSpecial:
        "eax ebx ecx edx esi edi esp ebp eip rax rbx rcx rdx rsi rdi rsp rbp rip r8 r9 r10 r11 r12 r13 r14 r15 al ah bl bh cl ch dl dh ax bx cx dx sp bp si di cs ds es fs gs ss xmm0 xmm1 xmm2 xmm3 xmm4 xmm5 xmm6 xmm7 lr pc xzr wzr fp zero ra gp tp a0 a1 a2 a3 a4 a5 a6 a7 t0 t1 t2 t3 t4 t5 t6 s0 s1 s2 s3 s4 s5 s6 s7 s8 s9 s10 s11 x0 x1 x2 x3 x4 x5 x6 x7 x8 x9 x10 x11 x12 x13 x14 x15 x16 x17 x18 x19 x20 x21 x22 x23 x24 x25 x26 x27 x28 x29 x30 w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 r0 r1 r2 r3 r4 r5 r6 r7",
      keyword:
        "byte word dword qword ptr section global extern db dw dd dq resb resw resd resq equ times",
    },
    capitalTypes: false,
    constantCase: false,
  },
  zig: {
    name: "zig",
    lineComment: ["//"],
    docComment: ["///", "//!"],
    strings: [DQ, SQ, { open: "\\\\", close: "", escape: false }],
    words: {
      keywordDeclaration: "fn const var struct enum union error opaque test",
      keyword:
        "pub extern export inline noinline comptime threadlocal align callconv linksection allowzero volatile packed anytype usingnamespace",
      keywordControl:
        "if else switch while for break continue return defer errdefer try catch orelse unreachable suspend resume nosuspend async await",
      keywordOperator: "and or",
      typeBuiltin:
        "i8 u8 i16 u16 i32 u32 i64 u64 i128 u128 isize usize f16 f32 f64 f128 bool void noreturn type anyerror comptime_int comptime_float anyopaque c_int c_uint c_long",
      boolean: "true false",
      constantBuiltin: "null undefined",
    },
    annotation: true,
    functionDecl: "fn",
  },
  dart: {
    name: "dart",
    ...C_COMMENTS,
    strings: ["'''", '"""', "'", '"'].map((open) => ({
      open,
      multiline: open.length === 3,
      interp: "${",
      vars: true,
      prefixes: "r",
    })),
    words: {
      keywordDeclaration: "class enum mixin extension typedef var final const late abstract",
      keyword:
        "static extends implements with required covariant factory external get set operator async await sync yield is as new show hide on deferred",
      keywordImport: "import export library part",
      keywordControl:
        "if else for in while do switch case default break continue return throw try catch finally rethrow assert",
      typeBuiltin: "int double num bool String void dynamic Object Never",
      boolean: "true false",
      constantBuiltin: "null",
      variableSpecial: "this super",
    },
    annotation: true,
    typeDecl: "class enum mixin extension typedef",
  },
  elixir: {
    name: "elixir",
    lineComment: ["#"],
    strings: [
      { open: '"""', multiline: true, interp: "#{" },
      { open: '"', multiline: true, interp: "#{" },
      SQ,
    ],
    words: {
      keywordDeclaration:
        "def defp defmodule defmacro defmacrop defstruct defprotocol defimpl defguard defdelegate defexception",
      keywordControl:
        "do end if else unless case cond with for receive try catch rescue after raise throw when fn quote unquote",
      keywordImport: "import require alias use",
      keywordOperator: "and or not in",
      boolean: "true false",
      constantBuiltin: "nil",
    },
    identPart: "?!",
    symbols: true,
    annotation: true,
    functionDecl: "def defp defmacro defmacrop defguard",
    typeDecl: "defmodule defprotocol defimpl",
  },
  erlang: {
    name: "erlang",
    lineComment: ["%"],
    strings: [DQ, { open: "'", token: T.stringSpecialSymbol }],
    words: {
      keyword: "after begin case catch cond end fun if let of receive try when maybe else",
      keywordOperator: "and andalso band bnot bor bsl bsr bxor div not or orelse rem xor",
      boolean: "true false",
    },
    capitalTypes: false,
    constantCase: false,
  },
  haskell: {
    name: "haskell",
    lineComment: ["--"],
    blockComment: [["{-", "-}"]],
    nestedComments: true,
    strings: [DQ, SQ],
    identPart: "'",
    words: {
      keyword:
        "case class data default deriving do else foreign if in infix infixl infixr instance let newtype of then type where qualified as hiding forall mdo family",
      keywordImport: "import module",
      boolean: "True False",
    },
    typeDecl: "data newtype type class instance",
    constantCase: false,
  },
  ocaml: {
    name: "ocaml",
    blockComment: [["(*", "*)"]],
    nestedComments: true,
    strings: [DQ],
    identPart: "'",
    words: {
      keyword:
        "and as assert begin class constraint do done downto else end exception external for fun function functor if in include inherit initializer lazy let match method module mutable new nonrec object of open or private rec sig struct then to try type val virtual when while with",
      boolean: "true false",
      typeBuiltin: "int float string bool char unit list array option ref",
    },
    typeDecl: "type module",
  },
  fsharp: {
    name: "fsharp",
    lineComment: ["//"],
    blockComment: [["(*", "*)"]],
    nestedComments: true,
    strings: [
      { open: '"""', multiline: true, prefixes: "$", interpPrefix: "$", interp: "{" },
      { open: '"', prefixes: "$@", interpPrefix: "$", interp: "{" },
    ],
    words: {
      keyword:
        "abstract and as assert base begin class default delegate do done downcast downto elif else end exception extern finally fixed for fun function global if in inherit inline interface internal lazy let match member module mutable namespace new not of open or override private public rec return select sig static struct then to try type upcast use val void when while with yield async task",
      boolean: "true false",
      constantBuiltin: "null",
      typeBuiltin: "int float string bool char unit list array option seq",
    },
    typeDecl: "type module",
    preprocessor: true,
  },
  scala: {
    name: "scala",
    ...C_COMMENTS,
    strings: [
      {
        open: '"""',
        multiline: true,
        prefixes: "sfr",
        interpPrefix: "sf",
        interp: "${",
        vars: true,
      },
      { open: '"', prefixes: "sfr", interpPrefix: "sf", interp: "${", vars: true },
      SQ,
    ],
    words: {
      keywordDeclaration: "def val var class object trait type enum given",
      keyword:
        "abstract case catch do else extends final finally for forSome if implicit lazy match new override private protected return sealed throw try while with yield using then end derives inline opaque transparent",
      keywordImport: "import package export",
      typeBuiltin: "Int Long Short Byte Double Float Boolean Char String Unit Any AnyRef Nothing",
      boolean: "true false",
      constantBuiltin: "null",
      variableSpecial: "this super",
    },
    functionDecl: "def",
    typeDecl: "class object trait type enum",
    annotation: true,
  },
  lisp: {
    name: "lisp",
    lineComment: [";"],
    strings: [{ open: '"', multiline: true }],
    identChars: "-!?*+<>=/&%",
    identPart: ".:'#",
    symbols: true,
    lisp: true,
    words: LISP_WORDS,
    capitalTypes: false,
    constantCase: false,
  },
  r: {
    name: "r",
    lineComment: ["#"],
    strings: [
      { open: '"', multiline: true },
      { open: "'", multiline: true },
    ],
    identPart: ".",
    words: {
      keywordControl: "if else for while repeat break next return function in",
      boolean: "TRUE FALSE T F",
      constantBuiltin: "NULL NA NaN Inf NA_integer_ NA_real_ NA_character_",
    },
    capitalTypes: false,
    constantCase: false,
  },
  perl: {
    name: "perl",
    lineComment: ["#"],
    strings: [
      { open: '"', multiline: true, vars: true },
      { open: "'", multiline: true },
    ],
    sigils: "$@%",
    heredoc: "perl",
    arrowMember: true,
    regex: true,
    words: {
      keywordDeclaration: "my our local sub package",
      keywordImport: "use require no",
      keywordControl:
        "if elsif else unless while until for foreach do last next redo return die eval",
      keywordOperator: "and or not eq ne lt gt le ge cmp x",
    },
    functionDecl: "sub",
    typeDecl: "package",
  },
  applescript: {
    name: "applescript",
    lineComment: ["--", "#"],
    blockComment: [["(*", "*)"]],
    nestedComments: true,
    strings: [DQ],
    caseInsensitive: true,
    words: {
      keyword:
        "tell end to on set get if then else repeat while until with times in of the return script property global local my it me try error considering ignoring using terms from and or not is contains equal greater less than",
      boolean: "true false",
    },
    capitalTypes: false,
  },
  nix: {
    name: "nix",
    lineComment: ["#"],
    blockComment: [["/*", "*/"]],
    strings: [
      { open: "''", multiline: true, interp: "${", escape: false },
      { open: '"', multiline: true, interp: "${" },
    ],
    identPart: "-'",
    words: {
      keyword: "let in with rec inherit assert if then else or import",
      boolean: "true false",
      constantBuiltin: "null",
    },
    assignKeys: true,
  },
  hcl: {
    name: "hcl",
    lineComment: ["#", "//"],
    blockComment: [["/*", "*/"]],
    strings: [{ open: '"', interp: "${" }],
    heredoc: "ruby",
    words: {
      keyword:
        "resource data variable output locals module provider terraform for in if for_each count depends_on lifecycle dynamic",
      boolean: "true false",
      constantBuiltin: "null",
      typeBuiltin: "string number bool list map set object tuple any",
    },
    identPart: "-",
    assignKeys: true,
  },
  prisma: {
    name: "prisma",
    lineComment: ["//"],
    strings: [DQ],
    words: {
      keywordDeclaration: "model enum datasource generator type view",
      typeBuiltin: "String Int BigInt Float Decimal Boolean DateTime Json Bytes Unsupported",
      boolean: "true false",
    },
    annotation: true,
    assignKeys: true,
    typeDecl: "model enum type view",
  },
  protobuf: {
    name: "protobuf",
    ...C_COMMENTS,
    strings: [DQ, SQ],
    words: {
      keywordDeclaration: "message enum service rpc oneof extend",
      keyword:
        "option package syntax returns stream reserved extensions to max optional required repeated map edition",
      keywordImport: "import",
      typeBuiltin:
        "double float int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 sfixed32 sfixed64 bool string bytes",
      boolean: "true false",
    },
    typeDecl: "message enum service",
  },
  cmake: {
    name: "cmake",
    lineComment: ["#"],
    rawStarts: "#",
    rawComment: (line, at) => {
      const long = line[at] === "#" ? luaLong(false)(line, at + 1) : null;
      return long && { length: long.length + 1, close: long.close };
    },
    strings: [{ open: '"', multiline: true, interp: "${" }],
    caseInsensitive: true,
    words: {
      keywordControl:
        "if elseif else endif foreach endforeach while endwhile function endfunction macro endmacro return break continue",
      constantBuiltin: "on off true false yes no",
    },
    capitalTypes: false,
  },
  groovy: {
    name: "groovy",
    ...C_COMMENTS,
    strings: [
      { open: '"""', multiline: true, interp: "${", vars: true },
      { open: "'''", multiline: true },
      { open: '"', interp: "${", vars: true },
      SQ,
    ],
    words: {
      keyword:
        "abstract as def extends final implements in native new private protected public static synchronized throws trait transient volatile assert",
      keywordDeclaration: "class interface enum",
      keywordImport: "import package",
      keywordControl:
        "if else for while do switch case default break continue return throw try catch finally",
      typeBuiltin: "boolean byte char double float int long short void",
      boolean: "true false",
      constantBuiltin: "null",
      variableSpecial: "this super it",
    },
    annotation: true,
    regex: true,
    typeDecl: "class interface enum trait",
  },
  julia: {
    name: "julia",
    lineComment: ["#"],
    blockComment: [["#=", "=#"]],
    nestedComments: true,
    strings: [
      { open: '"""', multiline: true, interp: "$(", vars: true },
      { open: '"', interp: "$(", vars: true },
    ],
    words: {
      keywordDeclaration:
        "function macro struct mutable abstract primitive type module baremodule const global local let",
      keywordControl:
        "if elseif else end for while break continue return try catch finally do begin quote",
      keywordImport: "using import export",
      keywordOperator: "in isa where",
      boolean: "true false",
      constantBuiltin: "nothing missing Inf NaN",
    },
    identPart: "!",
    annotation: true,
    functionDecl: "function macro",
    typeDecl: "struct type module",
  },
  solidity: {
    name: "solidity",
    ...C_COMMENTS,
    strings: [DQ, SQ],
    words: {
      keywordDeclaration:
        "contract interface library function modifier event struct enum mapping constructor fallback receive error type using",
      keyword:
        "public private internal external pure view payable constant immutable virtual override abstract memory storage calldata indexed anonymous returns emit is new delete",
      keywordImport: "import pragma",
      keywordControl:
        "if else for while do break continue return throw try catch revert require assert unchecked",
      typeBuiltin:
        "address bool string bytes int uint int256 uint256 uint8 uint16 uint32 uint64 uint128 bytes32 bytes4 byte",
      boolean: "true false",
      variableSpecial: "this super msg block tx",
    },
    functionDecl: "function modifier",
    typeDecl: "contract interface library struct enum",
  },
  verilog: {
    name: "verilog",
    ...C_COMMENTS,
    strings: [DQ],
    sigils: "`$",
    sigilToken: "preproc",
    words: {
      keyword:
        "module endmodule macromodule input output inout wire reg logic integer real time parameter localparam assign always always_ff always_comb always_latch initial begin end if else case casez casex endcase default for while repeat forever posedge negedge or and not function endfunction task endtask generate endgenerate genvar typedef struct enum packed signed unsigned interface endinterface modport class endclass package endpackage import export virtual extends new return break continue int bit byte shortint longint string void",
    },
    capitalTypes: false,
  },
  vhdl: {
    name: "vhdl",
    lineComment: ["--"],
    blockComment: [["/*", "*/"]],
    strings: [DQ],
    caseInsensitive: true,
    words: {
      keyword:
        "entity architecture is of begin end port map signal variable constant type subtype process if then else elsif case when others for loop while generate component library use all in out inout buffer downto to function procedure return package body attribute select with after wait until report severity not and or xor nand nor rising_edge falling_edge",
      typeBuiltin:
        "std_logic std_logic_vector std_ulogic integer natural positive boolean bit bit_vector unsigned signed string real time",
      boolean: "true false",
    },
    capitalTypes: false,
    constantCase: false,
  },
  bat: {
    name: "bat",
    lineComment: ["::", "rem ", "REM ", "@rem ", "@REM "],
    strings: [DQ],
    caseInsensitive: true,
    sigils: "%!",
    symbols: true,
    words: {
      keyword:
        "echo set if else for in do goto call exit not exist defined errorlevel equ neq lss leq gtr geq setlocal endlocal pause shift start cd dir copy del move mkdir rmdir off on",
    },
    capitalTypes: false,
    constantCase: false,
  },
  awk: {
    name: "awk",
    lineComment: ["#"],
    strings: [DQ],
    regex: true,
    sigils: "$",
    words: {
      keyword:
        "BEGIN END function if else while for do break continue next nextfile exit return delete getline in printf print",
    },
    functionDecl: "function",
  },
  latex: {
    name: "latex",
    lineComment: ["%"],
    strings: [
      { open: "$$", multiline: true, escape: false },
      { open: "$", escape: false },
    ],
    sigils: "\\",
    sigilToken: "keyword",
    capitalTypes: false,
    constantCase: false,
  },
  http: {
    name: "http",
    lineComment: ["#"],
    strings: [DQ],
    identPart: "-",
    head: "property",
    words: { keyword: "GET POST PUT PATCH DELETE HEAD OPTIONS CONNECT TRACE HTTP" },
    capitalTypes: false,
    constantCase: false,
  },
  nginx: {
    name: "nginx",
    lineComment: ["#"],
    strings: [DQ, SQ],
    sigils: "$",
    head: "keyword",
    words: { keyword: "server location http events upstream if" },
    capitalTypes: false,
    constantCase: false,
  },
  "ssh-config": {
    name: "ssh-config",
    lineComment: ["#"],
    strings: [DQ],
    head: "keyword",
    capitalTypes: false,
    constantCase: false,
  },
  codeowners: {
    name: "codeowners",
    lineComment: ["#"],
    annotation: true,
    identChars: "*./",
    head: "string",
    capitalTypes: false,
    constantCase: false,
  },
  wasm: {
    name: "wasm",
    lineComment: [";;"],
    blockComment: [["(;", ";)"]],
    nestedComments: true,
    strings: [DQ],
    identPart: "._",
    sigils: "$",
    lisp: true,
    words: {
      keyword:
        "module func param result local global memory table export import type mut offset data elem start",
      keywordControl:
        "call call_indirect block loop if then else end br br_if br_table return drop select unreachable nop",
      typeBuiltin: "i32 i64 f32 f64 v128 funcref externref",
    },
    capitalTypes: false,
  },
  shader: {
    name: "shader",
    ...C_COMMENTS,
    strings: [DQ],
    words: SHADER_WORDS,
    preprocessor: true,
    annotation: true,
    functionDecl: "fn",
    typeDecl: "struct",
  },
  odin: {
    name: "odin",
    ...C_COMMENTS,
    nestedComments: true,
    strings: [DQ, SQ, { open: "`", multiline: true, escape: false }],
    words: {
      keywordDeclaration: "package proc struct enum union map bit_set distinct",
      keywordImport: "import foreign",
      keywordControl:
        "defer return break continue fallthrough if else for in not_in switch case do when where or_else or_return",
      keyword: "using dynamic cast transmute auto_cast context",
      typeBuiltin:
        "int i8 i16 i32 i64 i128 uint u8 u16 u32 u64 u128 uintptr f16 f32 f64 bool b8 b16 b32 b64 string cstring rune rawptr typeid any byte",
      boolean: "true false",
      constantBuiltin: "nil",
    },
    annotation: true,
  },
  gleam: {
    name: "gleam",
    lineComment: ["//"],
    docComment: ["///", "////"],
    strings: [DQ],
    words: {
      keyword: "as assert case const external if let opaque pub panic todo use",
      keywordDeclaration: "fn type",
      keywordImport: "import",
      boolean: "True False",
    },
    functionDecl: "fn",
    typeDecl: "type",
    annotation: true,
  },
  nim: {
    name: "nim",
    lineComment: ["#"],
    blockComment: [["#[", "]#"]],
    nestedComments: true,
    strings: [{ open: '"""', multiline: true, escape: false }, { open: '"', prefixes: "rR" }, SQ],
    words: {
      keyword:
        "addr as asm bind block cast concept const converter defer discard distinct do enum except export finally from func interface iterator let macro method mixin object of out proc ptr raise ref static template tuple type using var yield",
      keywordControl: "break case continue elif else end for if return try when while",
      keywordImport: "import include",
      keywordOperator: "and div in is isnot mod not notin or shl shr xor",
      boolean: "true false",
      constantBuiltin: "nil",
    },
    functionDecl: "proc func method template macro iterator converter",
    typeDecl: "type object enum",
  },
  typst: {
    name: "typst",
    ...C_COMMENTS,
    strings: [DQ, { open: "$", escape: false }],
    sigils: "#",
    sigilToken: "keyword",
    capitalTypes: false,
    constantCase: false,
  },
  cue: {
    name: "cue",
    ...C_COMMENTS,
    strings: [
      { open: '"""', multiline: true, interp: "\\(" },
      { open: '"', interp: "\\(" },
    ],
    words: {
      keyword: "package import let if for in",
      boolean: "true false",
      constantBuiltin: "null",
      typeBuiltin: "int float string bool bytes number uint",
    },
  },
  kdl: {
    name: "kdl",
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    nestedComments: true,
    strings: [DQ],
    rawString: rustRaw,
    rawStarts: "r",
    head: "tag",
    words: { boolean: "#true #false true false", constantBuiltin: "#null null" },
    identPart: "-",
    capitalTypes: false,
  },
  bicep: {
    name: "bicep",
    ...C_COMMENTS,
    strings: [
      { open: "'''", multiline: true, escape: false },
      { open: "'", interp: "${" },
    ],
    words: {
      keywordDeclaration: "param var resource module output targetScope type func metadata",
      keywordImport: "import",
      keyword: "existing if for in",
      boolean: "true false",
      constantBuiltin: "null",
      typeBuiltin: "string int bool object array any",
    },
    annotation: true,
  },
  mermaid: {
    name: "mermaid",
    lineComment: ["%%"],
    strings: [DQ],
    words: {
      keyword:
        "graph flowchart sequenceDiagram classDiagram stateDiagram stateDiagram-v2 erDiagram gantt pie journey gitGraph mindmap timeline participant actor note loop alt else opt par end subgraph direction TD TB BT RL LR class style linkStyle classDef click section title dateFormat",
    },
    identPart: "-",
    capitalTypes: false,
    constantCase: false,
  },
  coffeescript: {
    name: "coffeescript",
    lineComment: ["#"],
    blockComment: [["###", "###"]],
    strings: [
      { open: '"""', multiline: true, interp: "#{" },
      { open: "'''", multiline: true },
      { open: '"', multiline: true, interp: "#{" },
      { open: "'", multiline: true },
    ],
    words: {
      ...JS_WORDS,
      keywordControl: `${JS_WORDS.keywordControl} unless until then loop when by`,
      keywordOperator: "and or not is isnt",
      boolean: "true false yes no on off",
    },
    sigils: "@",
    regex: true,
    typeDecl: "class",
  },
  log: {
    name: "log",
    strings: [DQ],
    words: {
      keyword: "ERROR ERR FATAL CRITICAL",
      constant: "WARN WARNING",
      string: "INFO NOTICE",
      comment: "DEBUG TRACE VERBOSE",
      boolean: "true false",
      constantBuiltin: "null",
    },
    capitalTypes: false,
    constantCase: false,
  },
};

/** Regular expressions: escapes, classes, groups, quantifiers, anchors. */
const regexLexer: Lexer = {
  name: "regex",
  step(s, st) {
    const line = s.line;
    while (s.pos < s.end) {
      const at = s.pos;
      const c = line[at]!;
      if (c === "\\") s.emit(Math.min(escapeEnd(line, at, s.end), s.end), T.stringEscape);
      else if (c === "[") {
        let end = at + 1;
        while (end < s.end && line[end] !== "]") end += line[end] === "\\" ? 2 : 1;
        s.emit(Math.min(end + 1, s.end), T.stringSpecial);
      } else if (c === "(" || c === ")")
        s.emit(at + (c === "(" && line[at + 1] === "?" ? 2 : 1), T.punctuationBracket);
      else if ("*+?|".includes(c)) s.emit(at + 1, T.operator);
      else if (c === "{" && /^\{\d+(?:,\d*)?\}/u.test(line.slice(at)))
        s.emit(line.indexOf("}", at) + 1, T.operator);
      else if (c === "^" || c === "$") s.emit(at + 1, T.keyword);
      else {
        let end = at + 1;
        while (end < s.end && !"\\[]()*+?|{^$".includes(line[end]!)) end++;
        s.emit(end, T.stringRegex);
      }
    }
    return st;
  },
};

const lexers = new Map<string, Lexer>();

const FACTORIES: Readonly<Record<string, () => Lexer>> = {
  text: () => plainLexer,
  html: () => new MarkupLexer("html", getLexer),
  xml: () => new MarkupLexer("xml", getLexer),
  vue: () => new MarkupLexer("vue", getLexer),
  svelte: () => new MarkupLexer("svelte", getLexer),
  astro: () => new MarkupLexer("astro", getLexer),
  css: () => new CssLexer("css"),
  scss: () => new CssLexer("scss"),
  less: () => new CssLexer("less"),
  markdown: () => new MarkdownLexer("markdown", getLexer),
  mdx: () => new MarkdownLexer("mdx", getLexer),
  yaml: () => new YamlLexer(),
  toml: () => new TomlLexer(),
  ini: () => new IniLexer("ini"),
  dotenv: () => new IniLexer("dotenv"),
  properties: () => new IniLexer("properties"),
  diff: () => diffLexer,
  bash: () => new ShellLexer("bash"),
  dockerfile: () => new DockerfileLexer(getLexer),
  makefile: () => new MakefileLexer("makefile", getLexer),
  just: () => new MakefileLexer("just", getLexer),
  csv: () => csvLexer,
  regex: () => regexLexer,
  // ANSI escapes are stripped by the emitters; the lexer only sees plain text.
  ansi: () => plainLexer,
};

/** The lexer for a language name or alias. */
export function getLexer(language: string): Lexer | undefined {
  const name = lexerNameFor(language) ?? language;
  let lexer = lexers.get(name);
  if (lexer) return lexer;
  const factory = FACTORIES[name];
  const spec = SPECS[name];
  lexer = factory ? factory() : spec ? new ClikeLexer(spec) : undefined;
  if (lexer) lexers.set(name, lexer);
  return lexer;
}
