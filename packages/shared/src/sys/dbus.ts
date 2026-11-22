/**
 * A D-Bus client over the bus's Unix socket, speaking the wire protocol directly. Its surface
 * follows the subset of `dbus-next` T3 Code uses: messages, variants, signals, method
 * handlers and name requests. Values map as in dbus-next: 64-bit integers are bigints, `ay`
 * is a Buffer, dicts are objects, structs are arrays, `v` is a {@link Variant}.
 */
import { EventEmitter } from "node:events";
import * as NodeNet from "node:net";

export const MessageType = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 } as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];
export const MessageFlag = { NO_REPLY_EXPECTED: 1, NO_AUTO_START: 2 } as const;
export const NameFlag = { ALLOW_REPLACEMENT: 1, REPLACE_EXISTING: 2, DO_NOT_QUEUE: 4 } as const;
export const RequestNameReply = { PRIMARY_OWNER: 1, IN_QUEUE: 2, EXISTS: 3, ALREADY_OWNER: 4 } as const;
const NO_REPLY_EXPECTED = MessageFlag.NO_REPLY_EXPECTED;

export class Variant<T = unknown> {
  readonly signature: string;
  readonly value: T;
  constructor(signature: string, value: T) {
    this.signature = signature;
    this.value = value;
  }
}

export interface MessageLike {
  type?: MessageType | undefined;
  serial?: number | undefined;
  path?: string | undefined;
  interface?: string | undefined;
  member?: string | undefined;
  errorName?: string | undefined;
  replySerial?: number | undefined;
  destination?: string | undefined;
  sender?: string | undefined;
  signature?: string | undefined;
  body?: unknown[] | undefined;
  flags?: number | undefined;
}

export class Message {
  type: MessageType;
  serial: number;
  path: string;
  interface: string;
  member: string;
  errorName: string;
  replySerial: number;
  destination: string;
  sender: string;
  signature: string;
  body: unknown[];
  flags: number;
  constructor(m: MessageLike) {
    this.type = m.type ?? MessageType.METHOD_CALL;
    this.serial = m.serial ?? 0;
    this.path = m.path ?? "";
    this.interface = m.interface ?? "";
    this.member = m.member ?? "";
    this.errorName = m.errorName ?? "";
    this.replySerial = m.replySerial ?? 0;
    this.destination = m.destination ?? "";
    this.sender = m.sender ?? "";
    this.signature = m.signature ?? "";
    this.body = m.body ?? [];
    this.flags = m.flags ?? 0;
  }
  static newMethodReturn(call: Message, signature = "", body: unknown[] = []): Message {
    return new Message({ type: MessageType.METHOD_RETURN, replySerial: call.serial, destination: call.sender, signature, body });
  }
  static newError(call: Message, errorName: string, text = ""): Message {
    return new Message({ type: MessageType.ERROR, replySerial: call.serial, destination: call.sender, errorName, signature: "s", body: [text] });
  }
}

export class DBusError extends Error {
  readonly type: string;
  readonly text: string;
  readonly reply: Message | undefined;
  constructor(type: string, text: string, reply?: Message) {
    super(text ? `${type}: ${text}` : type);
    this.type = type;
    this.text = text;
    this.reply = reply;
  }
}

/** Splits a signature into its complete types. */
export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  let i = 0;
  const one = (): void => {
    const c = signature[i++];
    if (c === "a") one();
    else if (c === "(" || c === "{") {
      const close = c === "(" ? ")" : "}";
      while (signature[i] !== close) {
        if (i >= signature.length) throw new Error(`Unterminated signature ${signature}`);
        one();
      }
      i++;
    } else if (c === undefined || !"ybnqiuxtdhsogv".includes(c)) throw new Error(`Bad signature ${signature}`);
  };
  while (i < signature.length) {
    const start = i;
    one();
    types.push(signature.slice(start, i));
  }
  return types;
}

const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1 };

class Writer {
  buf = Buffer.alloc(256);
  len = 0;
  private reserve(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  align(n: number) {
    const pad = (n - (this.len % n)) % n;
    this.reserve(pad);
    this.buf.fill(0, this.len, this.len + pad);
    this.len += pad;
  }
  bytes(b: Uint8Array) {
    this.reserve(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  fixed(type: string, value: unknown) {
    this.align(ALIGN[type]!);
    const size = { y: 1, n: 2, q: 2, b: 4, i: 4, u: 4, h: 4, x: 8, t: 8, d: 8 }[type as "y"];
    this.reserve(size);
    const b = this.buf;
    const at = this.len;
    if (type === "y") b.writeUInt8(Number(value), at);
    else if (type === "n") b.writeInt16LE(Number(value), at);
    else if (type === "q") b.writeUInt16LE(Number(value), at);
    else if (type === "b") b.writeUInt32LE(value ? 1 : 0, at);
    else if (type === "i") b.writeInt32LE(Number(value), at);
    else if (type === "u" || type === "h") b.writeUInt32LE(Number(value), at);
    else if (type === "x") b.writeBigInt64LE(BigInt(value as number), at);
    else if (type === "t") b.writeBigUInt64LE(BigInt(value as number), at);
    else b.writeDoubleLE(Number(value), at);
    this.len += size;
  }
  string(type: string, value: unknown) {
    const s = Buffer.from(String(value), "utf8");
    if (type === "g") this.fixed("y", s.length);
    else this.fixed("u", s.length);
    this.bytes(s);
    this.bytes(Buffer.of(0));
  }
  value(type: string, value: unknown) {
    const c = type[0]!;
    if ("snqiuhbxtdy".includes(c)) {
      if (c === "s") this.string(c, value);
      else this.fixed(c, value);
    } else if (c === "o" || c === "g") this.string(c, value);
    else if (c === "v") {
      const v = value instanceof Variant ? value : guessVariant(value);
      this.string("g", v.signature);
      this.value(v.signature, v.value);
    } else if (c === "(") {
      this.align(8);
      const fields = splitSignature(type.slice(1, -1));
      const values = value as unknown[];
      fields.forEach((field, k) => this.value(field, values[k]));
    } else if (c === "a") {
      const element = type.slice(1);
      this.align(4);
      const lengthAt = this.len;
      this.fixed("u", 0);
      this.align(ALIGN[element[0]!]!);
      const start = this.len;
      if (element === "y") this.bytes(typeof value === "string" ? Buffer.from(value) : Uint8Array.from(value as ArrayLike<number>));
      else if (element[0] === "{") {
        const [keyType, valueType] = splitSignature(element.slice(1, -1)) as [string, string];
        const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
        for (const [k, v] of entries) {
          this.align(8);
          this.value(keyType, "xtnqiuy".includes(keyType) ? Number(k) : k);
          this.value(valueType, v);
        }
      } else for (const item of value as unknown[]) this.value(element, item);
      this.buf.writeUInt32LE(this.len - start, lengthAt);
    } else throw new Error(`Cannot marshal ${type}`);
  }
}

function guessVariant(value: unknown): Variant {
  if (typeof value === "string") return new Variant("s", value);
  if (typeof value === "boolean") return new Variant("b", value);
  if (typeof value === "number") return new Variant(Number.isInteger(value) ? "i" : "d", value);
  if (typeof value === "bigint") return new Variant("x", value);
  throw new Error("Variant values need an explicit signature.");
}

class Reader {
  private readonly buf: Buffer;
  pos: number;
  private readonly le: boolean;
  constructor(buf: Buffer, pos: number, le: boolean) {
    this.buf = buf;
    this.pos = pos;
    this.le = le;
  }
  align(n: number) {
    this.pos += (n - (this.pos % n)) % n;
  }
  fixed(type: string): number | bigint | boolean {
    this.align(ALIGN[type]!);
    const b = this.buf;
    const at = this.pos;
    const le = this.le;
    const read = {
      y: () => [b.readUInt8(at), 1],
      n: () => [le ? b.readInt16LE(at) : b.readInt16BE(at), 2],
      q: () => [le ? b.readUInt16LE(at) : b.readUInt16BE(at), 2],
      b: () => [(le ? b.readUInt32LE(at) : b.readUInt32BE(at)) !== 0, 4],
      i: () => [le ? b.readInt32LE(at) : b.readInt32BE(at), 4],
      u: () => [le ? b.readUInt32LE(at) : b.readUInt32BE(at), 4],
      h: () => [le ? b.readUInt32LE(at) : b.readUInt32BE(at), 4],
      x: () => [le ? b.readBigInt64LE(at) : b.readBigInt64BE(at), 8],
      t: () => [le ? b.readBigUInt64LE(at) : b.readBigUInt64BE(at), 8],
      d: () => [le ? b.readDoubleLE(at) : b.readDoubleBE(at), 8],
    }[type as "y"]() as [number | bigint | boolean, number];
    this.pos += read[1];
    return read[0];
  }
  string(type: string): string {
    const length = Number(this.fixed(type === "g" ? "y" : "u"));
    const s = this.buf.toString("utf8", this.pos, this.pos + length);
    this.pos += length + 1;
    return s;
  }
  value(type: string): unknown {
    const c = type[0]!;
    if (c === "s" || c === "o" || c === "g") return this.string(c);
    if ("ybnqiuxtdh".includes(c)) return this.fixed(c);
    if (c === "v") {
      const signature = this.string("g");
      return new Variant(signature, this.value(signature));
    }
    if (c === "(") {
      this.align(8);
      return splitSignature(type.slice(1, -1)).map((field) => this.value(field));
    }
    if (c === "a") {
      const element = type.slice(1);
      const length = Number(this.fixed("u"));
      this.align(ALIGN[element[0]!]!);
      const end = this.pos + length;
      if (element === "y") {
        const bytes = Buffer.from(this.buf.subarray(this.pos, end));
        this.pos = end;
        return bytes;
      }
      if (element[0] === "{") {
        const [keyType, valueType] = splitSignature(element.slice(1, -1)) as [string, string];
        const out: Record<string, unknown> = {};
        while (this.pos < end) {
          this.align(8);
          const key = String(this.value(keyType));
          out[key] = this.value(valueType);
        }
        return out;
      }
      const items: unknown[] = [];
      while (this.pos < end) items.push(this.value(element));
      return items;
    }
    throw new Error(`Cannot unmarshal ${type}`);
  }
}

const FIELDS = [
  [1, "path", "o"],
  [2, "interface", "s"],
  [3, "member", "s"],
  [4, "errorName", "s"],
  [5, "replySerial", "u"],
  [6, "destination", "s"],
  [7, "sender", "s"],
  [8, "signature", "g"],
] as const;

export function encodeMessage(m: Message): Buffer {
  const body = new Writer();
  for (const [k, type] of splitSignature(m.signature).entries()) body.value(type, m.body[k]);
  const w = new Writer();
  w.bytes(Buffer.from([0x6c, m.type, m.flags, 1]));
  w.fixed("u", body.len);
  w.fixed("u", m.serial);
  const fields: Array<[number, Variant]> = [];
  for (const [code, key, type] of FIELDS) {
    const v = m[key];
    if (v !== "" && v !== 0) fields.push([code, new Variant(type, v)]);
  }
  w.value("a(yv)", fields);
  w.align(8);
  w.bytes(body.buf.subarray(0, body.len));
  return Buffer.from(w.buf.subarray(0, w.len));
}

/** The byte length of the first complete message in `buf`, or 0 if it is still incomplete. */
export function messageLength(buf: Buffer): number {
  if (buf.length < 16) return 0;
  const le = buf[0] === 0x6c;
  const bodyLength = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLength = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const total = Math.ceil((16 + fieldsLength) / 8) * 8 + bodyLength;
  return buf.length >= total ? total : 0;
}

export function decodeMessage(buf: Buffer): Message {
  const le = buf[0] === 0x6c;
  const r = new Reader(buf, 4, le);
  const bodyLength = Number(r.fixed("u"));
  const serial = Number(r.fixed("u"));
  const fields = r.value("a(yv)") as Array<[number, Variant]>;
  const m = new Message({ type: buf[1] as MessageType, flags: buf[2]!, serial });
  for (const [code, v] of fields) {
    const field = FIELDS.find(([c]) => c === code);
    if (field) (m as unknown as Record<string, unknown>)[field[1]] = v.value;
  }
  r.align(8);
  const end = r.pos + bodyLength;
  m.body = splitSignature(m.signature).map((type) => r.value(type));
  r.pos = end;
  return m;
}

type MethodHandler = (message: Message) => boolean;

export class MessageBus extends EventEmitter {
  name: string | null = null;
  private serial = 1;
  private readonly socket: NodeNet.Socket;
  private readonly pending = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  private readonly handlers: MethodHandler[] = [];
  private readonly ready: Promise<void>;
  private connected = false;

  constructor(address: string) {
    super();
    this.socket = NodeNet.connect(parseAddress(address));
    const failed = (error: Error) => {
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      if (this.listenerCount("error") > 0) this.emit("error", error);
    };
    this.socket.on("error", failed);
    this.socket.on("close", () => {
      if (this.connected) failed(new Error("The D-Bus connection closed."));
      this.connected = false;
    });
    this.ready = this.authenticate().then(async () => {
      this.connected = true;
      const reply = await this.request(
        new Message({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "Hello" }),
      );
      this.name = String(reply?.body[0] ?? "");
      this.emit("connect");
    });
    this.ready.catch(failed);
  }

  private authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const uid = process.getuid?.() ?? 0;
      let text = "";
      const onData = (chunk: Buffer) => {
        text += chunk.toString("latin1");
        if (!text.includes("\r\n")) return;
        this.socket.off("data", onData);
        if (!text.startsWith("OK ")) return reject(new Error(`D-Bus authentication failed: ${text.trim()}`));
        this.socket.write("BEGIN\r\n");
        let buffer: Buffer = Buffer.alloc(0);
        this.socket.on("data", (data: Buffer) => {
          buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
          for (let length = messageLength(buffer); length > 0; length = messageLength(buffer)) {
            const message = decodeMessage(buffer.subarray(0, length));
            buffer = buffer.subarray(length);
            this.dispatch(message);
          }
        });
        resolve();
      };
      this.socket.on("data", onData);
      this.socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid)).toString("hex")}\r\n`);
    });
  }

  private dispatch(message: Message) {
    if (message.type === MessageType.METHOD_RETURN || message.type === MessageType.ERROR) {
      const waiter = this.pending.get(message.replySerial);
      if (waiter) {
        this.pending.delete(message.replySerial);
        if (message.type === MessageType.ERROR) waiter.reject(new DBusError(message.errorName, String(message.body[0] ?? ""), message));
        else waiter.resolve(message);
      }
    } else if (message.type === MessageType.METHOD_CALL) {
      if (!this.handlers.some((handler) => handler(message)) && !(message.flags & NO_REPLY_EXPECTED)) {
        this.send(Message.newError(message, "org.freedesktop.DBus.Error.UnknownMethod", `No handler for ${message.interface}.${message.member}`));
      }
    }
    this.emit("message", message);
  }

  private write(message: Message) {
    if (!message.serial) message.serial = this.serial++;
    this.socket.write(encodeMessage(message));
  }

  /** Sends a method call and resolves with its reply; D-Bus errors reject as {@link DBusError}. */
  async call(message: Message): Promise<Message | null> {
    await this.ready;
    return this.request(message);
  }

  private request(message: Message): Promise<Message | null> {
    message.serial = this.serial++;
    if (message.flags & NO_REPLY_EXPECTED) {
      this.write(message);
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.serial, { resolve, reject });
      this.write(message);
    });
  }

  send(message: Message): void {
    void this.ready.then(() => this.write(message), () => undefined);
  }

  addMethodHandler(handler: MethodHandler): void {
    this.handlers.push(handler);
  }

  async requestName(name: string, flags = 0): Promise<number> {
    const reply = await this.call(
      new Message({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "RequestName",
        signature: "su",
        body: [name, flags],
      }),
    );
    return Number(reply?.body[0]);
  }

  disconnect(): void {
    this.connected = false;
    this.socket.destroy();
  }
}

function parseAddress(address: string): NodeNet.NetConnectOpts {
  for (const entry of address.split(";")) {
    const [transport, params = ""] = entry.split(/:(.*)/s) as [string, string?];
    if (transport !== "unix") continue;
    const values = Object.fromEntries(params.split(",").map((kv) => kv.split(/=(.*)/s).map(decodeURIComponent)));
    if (values.path) return { path: values.path };
    if (values.abstract) return { path: `\0${values.abstract}` };
  }
  throw new Error(`Unsupported D-Bus address ${address}`);
}

export function sessionBus(): MessageBus {
  const address =
    process.env.DBUS_SESSION_BUS_ADDRESS ?? (process.env.XDG_RUNTIME_DIR ? `unix:path=${process.env.XDG_RUNTIME_DIR}/bus` : "");
  return new MessageBus(address);
}
