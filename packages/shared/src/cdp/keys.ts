// Compact US keyboard definitions and modifier chord parser for CDP Input.dispatchKeyEvent.

export interface KeyDescriptor {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string;
  readonly location?: number;
}

const SPECIAL_KEYS: Readonly<Record<string, KeyDescriptor>> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
  CapsLock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  F1: { key: "F1", code: "F1", keyCode: 112 },
  F2: { key: "F2", code: "F2", keyCode: 113 },
  F3: { key: "F3", code: "F3", keyCode: 114 },
  F4: { key: "F4", code: "F4", keyCode: 115 },
  F5: { key: "F5", code: "F5", keyCode: 116 },
  F6: { key: "F6", code: "F6", keyCode: 117 },
  F7: { key: "F7", code: "F7", keyCode: 118 },
  F8: { key: "F8", code: "F8", keyCode: 119 },
  F9: { key: "F9", code: "F9", keyCode: 120 },
  F10: { key: "F10", code: "F10", keyCode: 121 },
  F11: { key: "F11", code: "F11", keyCode: 122 },
  F12: { key: "F12", code: "F12", keyCode: 123 },
};

const PUNCTUATION: Readonly<Record<string, readonly [code: string, keyCode: number]>> = {
  "-": ["Minus", 189],
  _: ["Minus", 189],
  "=": ["Equal", 187],
  "+": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "{": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "}": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  "|": ["Backslash", 220],
  ";": ["Semicolon", 186],
  ":": ["Semicolon", 186],
  "'": ["Quote", 222],
  '"': ["Quote", 222],
  ",": ["Comma", 188],
  "<": ["Comma", 188],
  ".": ["Period", 190],
  ">": ["Period", 190],
  "/": ["Slash", 191],
  "?": ["Slash", 191],
  "`": ["Backquote", 192],
  "~": ["Backquote", 192],
};

export const MODIFIER_BITS: Readonly<Record<string, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export function describeKey(key: string): KeyDescriptor {
  const normalized =
    key === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : key;
  const special = SPECIAL_KEYS[normalized];
  if (special) return special;
  if (normalized.length === 1) {
    const ch = normalized;
    if (/^[a-zA-Z]$/.test(ch)) {
      const upper = ch.toUpperCase();
      return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch };
    }
    if (/^[0-9]$/.test(ch)) {
      return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    }
    const punct = PUNCTUATION[ch];
    if (punct) return { key: ch, code: punct[0], keyCode: punct[1], text: ch };
    return { key: ch, code: "", keyCode: ch.charCodeAt(0), text: ch };
  }
  return { key: normalized, code: normalized, keyCode: 0 };
}

export function parseKeyChord(chord: string): {
  readonly modifiers: ReadonlyArray<KeyDescriptor>;
  readonly modifierMask: number;
  readonly main: KeyDescriptor;
  readonly commands?: ReadonlyArray<string>;
} {
  // Handle literal "+" as main key (e.g. "+" or "Shift++").
  const parts: Array<string> = [];
  let token = "";
  for (let i = 0; i < chord.length; i += 1) {
    const ch = chord[i]!;
    if (ch === "+" && token.length > 0) {
      parts.push(token);
      token = "";
    } else {
      token += ch;
    }
  }
  if (token.length > 0) parts.push(token);

  const mainRaw = parts.pop() ?? "";
  const modifiers: Array<KeyDescriptor> = [];
  let modifierMask = 0;

  for (const raw of parts) {
    const desc = describeKey(raw);
    const bit = MODIFIER_BITS[desc.key];
    if (bit !== undefined) {
      modifierMask |= bit;
      modifiers.push(desc);
    }
  }

  const main = describeKey(mainRaw);
  const commands = editingCommandsFor(main.key, modifierMask);
  return {
    modifiers,
    modifierMask,
    main,
    ...(commands ? { commands } : {}),
  };
}

function editingCommandsFor(key: string, modifierMask: number): ReadonlyArray<string> | undefined {
  const primary = modifierMask & 0b0111;
  if (primary !== 2 && primary !== 4) return undefined;
  switch (key.toLowerCase()) {
    case "a":
      return ["selectAll"];
    case "c":
      return ["copy"];
    case "x":
      return ["cut"];
    case "v":
      return ["paste"];
    case "z":
      return [modifierMask & 8 ? "redo" : "undo"];
    default:
      return undefined;
  }
}
