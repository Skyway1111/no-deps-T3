/**
 * Zero-dependency streaming selective JSON scanner.
 *
 * Streams UTF-16 string or UTF-8 Uint8Array chunks without materializing tokens,
 * path copies, or unselected subtrees. Enforces strict RFC 8259 syntax, max nesting
 * depth, and memory reservation budgets even when chunks split arbitrarily.
 */

export type JsonPathSegment = string | number | null;
export type JsonPath = ReadonlyArray<JsonPathSegment>;

class StreamJsonLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamJsonLimitError";
  }
}

export interface StreamJsonReaderOptions {
  readonly maxDepth?: number | undefined;
  readonly reserve?: ((bytes: number) => void) | undefined;
  readonly selectPath?: ((path: JsonPath) => boolean) | undefined;
  readonly onDepthLimit?: (() => never) | undefined;
}

export interface StreamJsonReader {
  write(chunk: string): void;
  writeBytes(chunk: Uint8Array): void;
  finish(): unknown;
}

const MODE_EXPECT_VALUE = 0;
const MODE_AFTER_VALUE = 1;
const MODE_OBJECT_KEY_OR_END = 2;
const MODE_OBJECT_KEY = 3;
const MODE_OBJECT_COLON = 4;
const MODE_STRING = 5;
const MODE_NUMBER = 6;
const MODE_LITERAL = 7;

const STR_PLAIN = 0;
const STR_ESCAPE = 1;
const STR_UNICODE = 2;

const NUM_SIGN = 0;
const NUM_ZERO = 1;
const NUM_INT = 2;
const NUM_FRAC_START = 3;
const NUM_FRAC = 4;
const NUM_EXP_SIGN = 5;
const NUM_EXP_START = 6;
const NUM_EXP = 7;

interface Frame {
  readonly kind: 0 | 1; // 0 = object, 1 = array
  readonly selected: boolean;
  readonly target: Record<string, unknown> | Array<unknown> | null;
  key: string | null;
  index: number;
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

function setObjectProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

export function createStreamJsonReader(options: StreamJsonReaderOptions = {}): StreamJsonReader {
  const maxDepth = options.maxDepth ?? 128;
  const reserve = options.reserve;
  const selectPath = options.selectPath;
  const onDepthLimit = options.onDepthLimit;

  const stack: Array<Frame> = [];
  const path: Array<JsonPathSegment> = [];
  let rootValue: unknown = undefined;
  let rootSelected = false;
  let hasRoot = false;
  let malformed = false;
  let mode = MODE_EXPECT_VALUE;

  // String scanner state (shared for keys and values; zero allocation when !captureString).
  let stringForKey = false;
  let captureString = false;
  let stringState = STR_PLAIN;
  let stringBuf = "";
  let unicodeAccum = 0;
  let unicodeRemaining = 0;

  // Number scanner state (zero allocation when !captureNumber).
  let captureNumber = false;
  let numState = NUM_SIGN;
  let numBuf = "";

  // Literal scanner state ("true", "false", "null").
  let literalTarget = "";
  let literalValue: boolean | null = null;
  let literalIndex = 0;
  let literalSelected = false;

  let utf8Decoder: TextDecoder | null = null;

  const failSyntax = (): void => {
    malformed = true;
  };

  const emitValue = (value: unknown, selected: boolean): void => {
    const parent = stack.length > 0 ? stack[stack.length - 1]! : null;
    if (parent === null) {
      if (selected) rootValue = value;
      hasRoot = true;
      mode = MODE_AFTER_VALUE;
      return;
    }
    if (parent.kind === 0) {
      if (selected && parent.target !== null && parent.key !== null) {
        setObjectProperty(parent.target as Record<string, unknown>, parent.key, value);
      }
      parent.key = null;
    } else {
      if (selected && parent.target !== null) {
        (parent.target as Array<unknown>).push(value);
      }
      parent.index += 1;
    }
    path.pop();
    mode = MODE_AFTER_VALUE;
  };

  const evaluateValueSelected = (): boolean => {
    const parent = stack.length > 0 ? stack[stack.length - 1]! : null;
    if (parent === null) {
      rootSelected = selectPath ? selectPath(path) : true;
      return rootSelected;
    }
    const seg: JsonPathSegment = parent.kind === 0 ? parent.key : parent.index;
    path.push(seg);
    if (!parent.selected) return false;
    return selectPath ? selectPath(path) : true;
  };

  const checkDepthLimit = (): void => {
    if (stack.length > maxDepth) {
      if (onDepthLimit) onDepthLimit();
      throw new StreamJsonLimitError("JSON nesting exceeds the depth limit");
    }
  };

  const beginContainer = (kind: 0 | 1): void => {
    const selected = evaluateValueSelected();
    let target: Record<string, unknown> | Array<unknown> | null = null;
    if (selected) {
      if (reserve) reserve(64);
      target = kind === 0 ? {} : [];
    }
    stack.push({ kind, selected, target, key: null, index: 0 });
    checkDepthLimit();
    mode = kind === 0 ? MODE_OBJECT_KEY_OR_END : MODE_EXPECT_VALUE;
  };

  const closeContainer = (expectedKind: 0 | 1): boolean => {
    if (stack.length === 0) return false;
    const frame = stack[stack.length - 1]!;
    if (frame.kind !== expectedKind) return false;
    stack.pop();
    emitValue(frame.target, frame.selected);
    return true;
  };

  const beginValueAt = (chunk: string, idx: number, code: number): number => {
    if (code === 0x7b) {
      // '{'
      beginContainer(0);
      return idx + 1;
    }
    if (code === 0x5b) {
      // '['
      beginContainer(1);
      return idx + 1;
    }
    if (code === 0x22) {
      // '"'
      const selected = evaluateValueSelected();
      stringForKey = false;
      captureString = selected;
      if (selected && reserve) reserve(64);
      stringState = STR_PLAIN;
      stringBuf = "";
      mode = MODE_STRING;
      return idx + 1;
    }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      // '-' or '0'..'9'
      const selected = evaluateValueSelected();
      captureNumber = selected;
      if (selected && reserve) reserve(64);
      numBuf = selected ? chunk[idx]! : "";
      numState = code === 0x2d ? NUM_SIGN : code === 0x30 ? NUM_ZERO : NUM_INT;
      mode = MODE_NUMBER;
      return idx + 1;
    }
    if (code === 0x74) {
      // 't'
      literalSelected = evaluateValueSelected();
      if (literalSelected && reserve) reserve(64);
      literalTarget = "true";
      literalValue = true;
      literalIndex = 1;
      mode = MODE_LITERAL;
      return idx + 1;
    }
    if (code === 0x66) {
      // 'f'
      literalSelected = evaluateValueSelected();
      if (literalSelected && reserve) reserve(64);
      literalTarget = "false";
      literalValue = false;
      literalIndex = 1;
      mode = MODE_LITERAL;
      return idx + 1;
    }
    if (code === 0x6e) {
      // 'n'
      literalSelected = evaluateValueSelected();
      if (literalSelected && reserve) reserve(64);
      literalTarget = "null";
      literalValue = null;
      literalIndex = 1;
      mode = MODE_LITERAL;
      return idx + 1;
    }
    failSyntax();
    return chunk.length;
  };

  const finishNumber = (): boolean => {
    if (
      numState === NUM_SIGN ||
      numState === NUM_FRAC_START ||
      numState === NUM_EXP_SIGN ||
      numState === NUM_EXP_START
    ) {
      failSyntax();
      return false;
    }
    const val = captureNumber ? Number(numBuf) : 0;
    numBuf = "";
    emitValue(val, captureNumber);
    return true;
  };

  const scanString = (chunk: string, start: number): number => {
    const len = chunk.length;
    let i = start;

    while (i < len) {
      if (stringState === STR_PLAIN) {
        const segStart = i;
        while (i < len) {
          const code = chunk.charCodeAt(i);
          if (code === 0x22 || code === 0x5c || code < 0x20) break;
          i += 1;
        }
        if (captureString && i > segStart) {
          const slice = chunk.slice(segStart, i);
          if (reserve) reserve(slice.length * 2);
          stringBuf += slice;
        }
        if (i >= len) return len;
        const code = chunk.charCodeAt(i);
        if (code < 0x20) {
          failSyntax();
          return len;
        }
        if (code === 0x5c) {
          stringState = STR_ESCAPE;
          i += 1;
          continue;
        }
        // Closing quote '"'
        i += 1;
        const finished = stringBuf;
        stringBuf = "";
        if (stringForKey) {
          const parent = stack[stack.length - 1]!;
          parent.key = captureString ? finished : null;
          mode = MODE_OBJECT_COLON;
        } else {
          emitValue(finished, captureString);
        }
        return i;
      }

      if (stringState === STR_ESCAPE) {
        const code = chunk.charCodeAt(i);
        i += 1;
        let ch: string;
        switch (code) {
          case 0x22:
            ch = '"';
            break;
          case 0x5c:
            ch = "\\";
            break;
          case 0x2f:
            ch = "/";
            break;
          case 0x62:
            ch = "\b";
            break;
          case 0x66:
            ch = "\f";
            break;
          case 0x6e:
            ch = "\n";
            break;
          case 0x72:
            ch = "\r";
            break;
          case 0x74:
            ch = "\t";
            break;
          case 0x75:
            unicodeAccum = 0;
            unicodeRemaining = 4;
            stringState = STR_UNICODE;
            continue;
          default:
            failSyntax();
            return len;
        }
        if (captureString) {
          if (reserve) reserve(2);
          stringBuf += ch;
        }
        stringState = STR_PLAIN;
        continue;
      }

      // STR_UNICODE
      const hex = hexValue(chunk.charCodeAt(i));
      if (hex === -1) {
        failSyntax();
        return len;
      }
      unicodeAccum = (unicodeAccum << 4) | hex;
      unicodeRemaining -= 1;
      i += 1;
      if (unicodeRemaining === 0) {
        if (captureString) {
          if (reserve) reserve(2);
          stringBuf += String.fromCharCode(unicodeAccum);
        }
        stringState = STR_PLAIN;
      }
    }
    return len;
  };

  const scanNumber = (chunk: string, start: number): number => {
    const len = chunk.length;
    let i = start;
    const segStart = i;

    while (i < len) {
      const code = chunk.charCodeAt(i);
      const isDigit = code >= 0x30 && code <= 0x39;
      let advance = false;
      switch (numState) {
        case NUM_SIGN:
          if (code === 0x30) {
            numState = NUM_ZERO;
            advance = true;
          } else if (code >= 0x31 && code <= 0x39) {
            numState = NUM_INT;
            advance = true;
          } else {
            failSyntax();
            return len;
          }
          break;
        case NUM_ZERO:
          if (code === 0x2e) {
            numState = NUM_FRAC_START;
            advance = true;
          } else if (code === 0x65 || code === 0x45) {
            numState = NUM_EXP_SIGN;
            advance = true;
          } else if (isDigit) {
            failSyntax();
            return len;
          }
          break;
        case NUM_INT:
          if (isDigit) {
            advance = true;
          } else if (code === 0x2e) {
            numState = NUM_FRAC_START;
            advance = true;
          } else if (code === 0x65 || code === 0x45) {
            numState = NUM_EXP_SIGN;
            advance = true;
          }
          break;
        case NUM_FRAC_START:
          if (isDigit) {
            numState = NUM_FRAC;
            advance = true;
          } else {
            failSyntax();
            return len;
          }
          break;
        case NUM_FRAC:
          if (isDigit) {
            advance = true;
          } else if (code === 0x65 || code === 0x45) {
            numState = NUM_EXP_SIGN;
            advance = true;
          }
          break;
        case NUM_EXP_SIGN:
          if (code === 0x2b || code === 0x2d) {
            numState = NUM_EXP_START;
            advance = true;
          } else if (isDigit) {
            numState = NUM_EXP;
            advance = true;
          } else {
            failSyntax();
            return len;
          }
          break;
        case NUM_EXP_START:
          if (isDigit) {
            numState = NUM_EXP;
            advance = true;
          } else {
            failSyntax();
            return len;
          }
          break;
        case NUM_EXP:
          if (isDigit) advance = true;
          break;
      }

      if (!advance) {
        if (captureNumber && i > segStart) {
          const slice = chunk.slice(segStart, i);
          if (reserve) reserve(slice.length * 2);
          numBuf += slice;
        }
        finishNumber();
        return i;
      }
      i += 1;
    }

    if (captureNumber && i > segStart) {
      const slice = chunk.slice(segStart, i);
      if (reserve) reserve(slice.length * 2);
      numBuf += slice;
    }
    return len;
  };

  const scanLiteral = (chunk: string, start: number): number => {
    const len = chunk.length;
    let i = start;
    while (i < len && literalIndex < literalTarget.length) {
      if (chunk.charCodeAt(i) !== literalTarget.charCodeAt(literalIndex)) {
        failSyntax();
        return len;
      }
      i += 1;
      literalIndex += 1;
    }
    if (literalIndex === literalTarget.length) {
      emitValue(literalValue, literalSelected);
    }
    return i;
  };

  const write = (chunk: string): void => {
    if (malformed || chunk.length === 0) return;
    const len = chunk.length;
    let i = 0;

    while (i < len && !malformed) {
      if (mode === MODE_STRING) {
        i = scanString(chunk, i);
        continue;
      }
      if (mode === MODE_NUMBER) {
        i = scanNumber(chunk, i);
        continue;
      }
      if (mode === MODE_LITERAL) {
        i = scanLiteral(chunk, i);
        continue;
      }

      // Skip JSON whitespace
      while (i < len && isWhitespace(chunk.charCodeAt(i))) i += 1;
      if (i >= len) break;
      const code = chunk.charCodeAt(i);

      switch (mode) {
        case MODE_EXPECT_VALUE: {
          if (code === 0x5d) {
            // ']' allowed only for an empty array (index === 0)
            const top = stack.length > 0 ? stack[stack.length - 1]! : null;
            if (top !== null && top.kind === 1 && top.index === 0) {
              closeContainer(1);
              i += 1;
            } else {
              failSyntax();
            }
            break;
          }
          i = beginValueAt(chunk, i, code);
          break;
        }

        case MODE_OBJECT_KEY_OR_END: {
          if (code === 0x7d) {
            // '}'
            if (!closeContainer(0)) failSyntax();
            i += 1;
            break;
          }
          if (code === 0x22) {
            // '"'
            const parent = stack[stack.length - 1]!;
            stringForKey = true;
            captureString = parent.selected;
            stringState = STR_PLAIN;
            stringBuf = "";
            mode = MODE_STRING;
            i += 1;
            break;
          }
          failSyntax();
          break;
        }

        case MODE_OBJECT_KEY: {
          if (code === 0x22) {
            const parent = stack[stack.length - 1]!;
            stringForKey = true;
            captureString = parent.selected;
            stringState = STR_PLAIN;
            stringBuf = "";
            mode = MODE_STRING;
            i += 1;
            break;
          }
          failSyntax();
          break;
        }

        case MODE_OBJECT_COLON: {
          if (code === 0x3a) {
            // ':'
            mode = MODE_EXPECT_VALUE;
            i += 1;
          } else {
            failSyntax();
          }
          break;
        }

        case MODE_AFTER_VALUE: {
          if (stack.length === 0) {
            // Trailing non-whitespace after root value is invalid JSON.
            failSyntax();
            break;
          }
          const parent = stack[stack.length - 1]!;
          if (code === 0x2c) {
            // ','
            mode = parent.kind === 0 ? MODE_OBJECT_KEY : MODE_EXPECT_VALUE;
            i += 1;
            break;
          }
          if (code === 0x7d && parent.kind === 0) {
            closeContainer(0);
            i += 1;
            break;
          }
          if (code === 0x5d && parent.kind === 1) {
            closeContainer(1);
            i += 1;
            break;
          }
          failSyntax();
          break;
        }
      }
    }
  };

  const writeBytes = (chunk: Uint8Array): void => {
    if (malformed || chunk.byteLength === 0) return;
    if (utf8Decoder === null) utf8Decoder = new TextDecoder("utf-8");
    write(utf8Decoder.decode(chunk, { stream: true }));
  };

  const finish = (): unknown => {
    if (utf8Decoder !== null) {
      const tail = utf8Decoder.decode();
      utf8Decoder = null;
      if (tail.length > 0) write(tail);
    }
    if (malformed) return undefined;
    if (mode === MODE_NUMBER) {
      if (!finishNumber()) return undefined;
    }
    if (malformed || !hasRoot || stack.length > 0 || mode !== MODE_AFTER_VALUE) {
      return undefined;
    }
    return rootSelected ? rootValue : undefined;
  };

  return { write, writeBytes, finish };
}
