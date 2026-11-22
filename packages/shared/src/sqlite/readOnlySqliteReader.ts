// Zero-dependency read-only SQLite3 binary file format reader (https://www.sqlite.org/fileformat.html).

export type SqliteValue = null | number | bigint | string | Uint8Array;

export interface SqliteDatabaseHeader {
  readonly pageSize: number;
  readonly reservedSpace: number;
  readonly usableSize: number;
  readonly pageCount: number;
  readonly textEncoding: "utf-8" | "utf-16le" | "utf-16be";
}

export interface SqliteColumnInfo {
  readonly name: string;
  readonly isRowidAlias: boolean;
  readonly isVirtual: boolean;
  readonly defaultValue: SqliteValue;
}

export interface SqliteTableInfo {
  readonly name: string;
  readonly rootPage: number;
  readonly sql: string;
  readonly columns: ReadonlyArray<SqliteColumnInfo>;
  readonly rowidAliasIndex: number;
  readonly withoutRowid: boolean;
  readonly storedOrder: ReadonlyArray<number> | null;
}

const SQLITE_MAGIC = "SQLite format 3\0";
const MAX_BTREE_DEPTH = 64;
const MAX_OVERFLOW_PAGES = 16_384;
const TABLE_CONSTRAINTS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const b = bytes[offset + i];
    if (b === undefined) throw new Error("Unexpected end of SQLite varint");
    value = (value << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  const last = bytes[offset + 8];
  if (last === undefined) throw new Error("Unexpected end of SQLite varint");
  return { value: (value << 8n) | BigInt(last), next: offset + 9 };
}

function unquoteIdent(raw: string): string {
  const s = raw.trim();
  const [a, b] = [s[0], s.at(-1)];
  if (s.length >= 2) {
    if (a === '"' && b === '"') return s.slice(1, -1).replaceAll('""', '"');
    if (a === "`" && b === "`") return s.slice(1, -1).replaceAll("``", "`");
    if (a === "[" && b === "]") return s.slice(1, -1);
    if (a === "'" && b === "'") return s.slice(1, -1).replaceAll("''", "'");
  }
  return s;
}

function skipQuoted(sql: string, i: number): number {
  const q = sql[i]!;
  if (q === "[") {
    const end = sql.indexOf("]", i + 1);
    return end === -1 ? sql.length : end + 1;
  }
  let cur = i + 1;
  while (cur < sql.length) {
    if (sql[cur] === q) {
      if (sql[cur + 1] === q) cur += 2;
      else return cur + 1;
    } else cur++;
  }
  return sql.length;
}

function stripSqlComments(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const next = skipQuoted(sql, i);
      out += sql.slice(i, next);
      i = next;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? sql.length : nl;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") i = skipQuoted(body, i) - 1;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (body.slice(start).trim()) parts.push(body.slice(start));
  return parts;
}

function readFirstToken(input: string): { token: string; rest: string } {
  const s = input.trimStart();
  if (!s) return { token: "", rest: "" };
  const c = s[0]!;
  if (c === '"' || c === "`" || c === "'" || c === "[") {
    const end = skipQuoted(s, 0);
    return { token: s.slice(0, end), rest: s.slice(end) };
  }
  const token = /^[^\s(),]+/.exec(s)?.[0] ?? s;
  return { token, rest: s.slice(token.length) };
}

function parseDefaultLiteral(rest: string): SqliteValue {
  const raw = /\bDEFAULT\s+('(?:''|[^'])*'|[+-]?\d+(?:\.\d+)?|\bNULL\b|\bTRUE\b|\bFALSE\b)/i.exec(rest)?.[1];
  if (!raw) return null;
  if (raw.startsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  const u = raw.toUpperCase();
  if (u === "NULL") return null;
  if (u === "TRUE") return 1;
  if (u === "FALSE") return 0;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
}

function parseCreateTable(sql: string) {
  const cleaned = stripSqlComments(sql);
  const openIdx = cleaned.indexOf("(");
  if (openIdx === -1) return { columns: [] as SqliteColumnInfo[], rowidAliasIndex: -1, withoutRowid: false, storedOrder: null };
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") i = skipQuoted(cleaned, i) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { columns: [] as SqliteColumnInfo[], rowidAliasIndex: -1, withoutRowid: false, storedOrder: null };

  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(cleaned.slice(closeIdx + 1));
  const columns: SqliteColumnInfo[] = [];
  const colRests: string[] = [];
  let tablePkCols: string[] | null = null;
  let inlinePkIdx = -1;

  for (const part of splitTopLevelCommas(cleaned.slice(openIdx + 1, closeIdx))) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const { token, rest } = readFirstToken(trimmed);
    const isQuoted = `"\`'[`.includes(token[0] ?? "");
    if (!isQuoted && TABLE_CONSTRAINTS.has(token.toUpperCase())) {
      const pk = /\bPRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(trimmed)?.[1];
      if (pk) tablePkCols = splitTopLevelCommas(pk).map((c) => unquoteIdent(readFirstToken(c).token).toLowerCase());
      continue;
    }
    const rt = rest.trim();
    const isGen = /\bGENERATED\s+ALWAYS\s+AS\s*\(|\bAS\s*\(/i.test(rt);
    const isVirtual = isGen && !/\bSTORED\b/i.test(rt);
    const isPk = /\bPRIMARY\s+KEY\b/i.test(rt);
    const isRowidAlias = !withoutRowid && isPk && /^INTEGER\b/i.test(rt) && !/\bPRIMARY\s+KEY\s+DESC\b/i.test(rt);
    if (isPk) inlinePkIdx = columns.length;
    colRests.push(rt);
    columns.push({ name: unquoteIdent(token), isRowidAlias, isVirtual, defaultValue: parseDefaultLiteral(rt) });
  }

  let rowidAliasIndex = columns.findIndex((c) => c.isRowidAlias);
  if (!withoutRowid && rowidAliasIndex === -1 && tablePkCols?.length === 1) {
    const idx = columns.findIndex((c) => c.name.toLowerCase() === tablePkCols![0]);
    if (idx !== -1 && /^INTEGER\b/i.test(colRests[idx] ?? "")) {
      rowidAliasIndex = idx;
      columns[idx] = { ...columns[idx]!, isRowidAlias: true };
    }
  }

  let storedOrder: number[] | null = null;
  if (withoutRowid) {
    const pkIndices = tablePkCols
      ? tablePkCols.map((n) => columns.findIndex((c) => c.name.toLowerCase() === n)).filter((i) => i !== -1)
      : inlinePkIdx !== -1
        ? [inlinePkIdx]
        : [];
    const pkSet = new Set(pkIndices);
    storedOrder = [...pkIndices, ...columns.map((_, i) => i).filter((i) => !pkSet.has(i) && !columns[i]!.isVirtual)];
  }
  return { columns, rowidAliasIndex, withoutRowid, storedOrder };
}

export class ReadOnlySqliteReader {
  readonly header: SqliteDatabaseHeader;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly textDecoder: TextDecoder;
  private readonly tableMap = new Map<string, SqliteTableInfo>();
  private readonly tableList: ReadonlyArray<SqliteTableInfo>;

  constructor(input: ArrayBuffer | Uint8Array) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (this.bytes.byteLength < 100) throw new Error("Invalid SQLite database: file is smaller than 100-byte header");
    for (let i = 0; i < SQLITE_MAGIC.length; i++) {
      if (this.bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) throw new Error("Invalid SQLite database: header magic mismatch");
    }
    const rawSize = this.view.getUint16(16, false);
    const pageSize = rawSize === 1 ? 65536 : rawSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new Error(`Invalid SQLite page size: ${pageSize}`);
    }
    const reservedSpace = this.view.getUint8(20);
    const usableSize = pageSize - reservedSpace;
    if (usableSize < 480) throw new Error(`Invalid SQLite usable page size: ${usableSize}`);
    const hdrPages = this.view.getUint32(28, false);
    const actualPages = Math.floor(this.bytes.byteLength / pageSize);
    const pageCount = hdrPages > 0 ? Math.min(hdrPages, actualPages) : actualPages;
    const enc = this.view.getUint32(56, false);
    const textEncoding = enc === 2 ? "utf-16le" : enc === 3 ? "utf-16be" : "utf-8";
    this.header = { pageSize, reservedSpace, usableSize, pageCount, textEncoding };
    this.textDecoder = new TextDecoder(textEncoding);

    const discovered: SqliteTableInfo[] = [];
    if (pageCount >= 1) {
      this.scanTree(1, 0, Infinity, (_rowid, rec) => {
        const [type, name, , rootPage, sql] = rec;
        if (type !== "table" || typeof name !== "string" || name.startsWith("sqlite_") || typeof sql !== "string" || /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql)) return;
        discovered.push({ name, rootPage: Number(rootPage ?? 0), sql, ...parseCreateTable(sql) });
      });
    }
    discovered.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.tableList = discovered;
    for (const t of discovered) this.tableMap.set(t.name, t);
  }

  tables(): ReadonlyArray<SqliteTableInfo> {
    return this.tableList;
  }

  getTable(name: string): SqliteTableInfo | undefined {
    return this.tableMap.get(name);
  }

  /** Fast O(pages) row count without decoding records or following overflow chains. */
  countRows(tableName: string): number {
    const table = this.tableMap.get(tableName);
    return table && table.rootPage >= 1 ? this.countPage(table.rootPage, 0, new Set()) : 0;
  }

  readRows(
    tableName: string,
    options: { readonly offset?: number | undefined; readonly limit?: number | undefined } = {},
  ): { readonly columns: ReadonlyArray<string>; readonly rows: ReadonlyArray<ReadonlyArray<SqliteValue>> } {
    const table = this.tableMap.get(tableName);
    if (!table) throw new Error(`Table not found: ${tableName}`);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit ?? Infinity;
    const visible = table.columns.filter((c) => !c.isVirtual);
    const rows: SqliteValue[][] = [];

    if (table.rootPage >= 1 && limit > 0) {
      this.scanTree(table.rootPage, offset, limit, (rowid, rec) => {
        if (table.withoutRowid && table.storedOrder) {
          const out = new Array<SqliteValue>(table.columns.length).fill(null);
          for (let i = 0; i < table.storedOrder.length; i++) {
            const colIdx = table.storedOrder[i]!;
            out[colIdx] = i < rec.length ? rec[i]! : table.columns[colIdx]!.defaultValue;
          }
          rows.push(out.filter((_, idx) => !table.columns[idx]!.isVirtual));
          return;
        }
        const out = new Array<SqliteValue>(visible.length);
        let rIdx = 0;
        for (let i = 0; i < table.columns.length; i++) {
          const col = table.columns[i]!;
          if (col.isVirtual) continue;
          let v: SqliteValue = rIdx < rec.length ? rec[rIdx]! : col.defaultValue;
          if (i === table.rowidAliasIndex && v === null && rowid !== null) {
            v = rowid >= BigInt(Number.MIN_SAFE_INTEGER) && rowid <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rowid) : rowid;
          }
          out[rIdx++] = v;
        }
        rows.push(out);
      });
    }
    return { columns: visible.map((c) => c.name), rows };
  }

  private pageStart(page: number): number {
    if (page < 1 || page > this.header.pageCount) throw new Error(`SQLite page ${page} out of range`);
    return (page - 1) * this.header.pageSize;
  }

  private countPage(page: number, depth: number, visited: Set<number>): number {
    if (depth > MAX_BTREE_DEPTH || visited.has(page)) throw new Error("Corrupt SQLite B-tree");
    visited.add(page);
    const start = this.pageStart(page);
    const hdr = start + (page === 1 ? 100 : 0);
    const type = this.bytes[hdr];
    const count = this.view.getUint16(hdr + 3, false);
    if (type === 0x0d || type === 0x0a) return count;
    if (type !== 0x05 && type !== 0x02) return 0;
    let total = type === 0x02 ? count : 0;
    for (let i = 0; i < count; i++) {
      const cell = start + this.view.getUint16(hdr + 12 + i * 2, false);
      total += this.countPage(this.view.getUint32(cell, false), depth + 1, visited);
    }
    const right = this.view.getUint32(hdr + 8, false);
    return right > 0 ? total + this.countPage(right, depth + 1, visited) : total;
  }

  private scanTree(
    root: number,
    skip: number,
    limit: number,
    onRow: (rowid: bigint | null, record: ReadonlyArray<SqliteValue>) => void,
  ) {
    this.walkPage(root, 0, skip, limit, { skipped: 0, emitted: 0 }, new Set(), onRow);
  }

  private walkPage(
    page: number,
    depth: number,
    skip: number,
    limit: number,
    state: { skipped: number; emitted: number },
    visited: Set<number>,
    onRow: (rowid: bigint | null, record: ReadonlyArray<SqliteValue>) => void,
  ) {
    if (state.emitted >= limit) return;
    if (depth > MAX_BTREE_DEPTH || visited.has(page)) throw new Error("Corrupt SQLite B-tree");
    visited.add(page);
    const start = this.pageStart(page);
    const hdr = start + (page === 1 ? 100 : 0);
    const type = this.bytes[hdr];
    const count = this.view.getUint16(hdr + 3, false);

    if (type === 0x05 || type === 0x02) {
      const right = this.view.getUint32(hdr + 8, false);
      for (let i = 0; i < count && state.emitted < limit; i++) {
        const cell = start + this.view.getUint16(hdr + 12 + i * 2, false);
        this.walkPage(this.view.getUint32(cell, false), depth + 1, skip, limit, state, visited, onRow);
        if (type === 0x02 && state.emitted < limit) {
          if (state.skipped < skip) { state.skipped++; continue; }
          const p = readVarint(this.bytes, cell + 4);
          onRow(null, this.decodeRecord(this.readPayload(p.next, Number(p.value), false)));
          state.emitted++;
        }
      }
      if (right > 0 && state.emitted < limit) this.walkPage(right, depth + 1, skip, limit, state, visited, onRow);
      return;
    }

    if (type !== 0x0d && type !== 0x0a) return;
    if (state.skipped + count <= skip) { state.skipped += count; return; }
    const startIdx = Math.max(0, skip - state.skipped);
    state.skipped += startIdx;
    for (let i = startIdx; i < count && state.emitted < limit; i++) {
      const cell = start + this.view.getUint16(hdr + 8 + i * 2, false);
      const p = readVarint(this.bytes, cell);
      if (type === 0x0d) {
        const rowid = readVarint(this.bytes, p.next);
        onRow(rowid.value, this.decodeRecord(this.readPayload(rowid.next, Number(p.value), true)));
      } else {
        onRow(null, this.decodeRecord(this.readPayload(p.next, Number(p.value), false)));
      }
      state.emitted++;
    }
  }

  private readPayload(offset: number, size: number, isTableLeaf: boolean): Uint8Array {
    const U = this.header.usableSize;
    const X = isTableLeaf ? U - 35 : Math.floor(((U - 12) * 64) / 255) - 23;
    if (size <= X) {
      if (offset + size > this.bytes.byteLength) throw new Error("Corrupt SQLite cell payload");
      return this.bytes.subarray(offset, offset + size);
    }
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (U - 4));
    const local = K <= X ? K : M;
    if (offset + local + 4 > this.bytes.byteLength) throw new Error("Corrupt SQLite overflow pointer");

    const out = new Uint8Array(size);
    out.set(this.bytes.subarray(offset, offset + local), 0);
    let written = local;
    let next = this.view.getUint32(offset + local, false);
    let steps = 0;
    while (written < size && next !== 0) {
      if (++steps > MAX_OVERFLOW_PAGES) throw new Error("Corrupt SQLite overflow chain");
      const start = this.pageStart(next);
      const take = Math.min(U - 4, size - written);
      out.set(this.bytes.subarray(start + 4, start + 4 + take), written);
      written += take;
      next = this.view.getUint32(start, false);
    }
    return out;
  }

  private decodeRecord(payload: Uint8Array): SqliteValue[] {
    if (payload.byteLength === 0) return [];
    const hdr = readVarint(payload, 0);
    const hdrEnd = Number(hdr.value);
    if (hdrEnd > payload.byteLength) throw new Error("Corrupt SQLite record header");
    const types: number[] = [];
    for (let c = hdr.next; c < hdrEnd; ) {
      const st = readVarint(payload, c);
      types.push(Number(st.value));
      c = st.next;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const values = new Array<SqliteValue>(types.length);
    let off = hdrEnd;
    for (let i = 0; i < types.length; i++) {
      const st = types[i]!;
      if (st === 0 || st === 10 || st === 11) values[i] = null;
      else if (st === 8) values[i] = 0;
      else if (st === 9) values[i] = 1;
      else if (st === 1) { values[i] = view.getInt8(off); off += 1; }
      else if (st === 2) { values[i] = view.getInt16(off, false); off += 2; }
      else if (st === 3) {
        const b0 = view.getUint8(off);
        const raw = (b0 << 16) | (view.getUint8(off + 1) << 8) | view.getUint8(off + 2);
        values[i] = b0 & 0x80 ? raw - 0x1000000 : raw;
        off += 3;
      } else if (st === 4) { values[i] = view.getInt32(off, false); off += 4; }
      else if (st === 5) { values[i] = view.getInt16(off, false) * 4294967296 + view.getUint32(off + 2, false); off += 6; }
      else if (st === 6) {
        const v = view.getBigInt64(off, false);
        values[i] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        off += 8;
      } else if (st === 7) { values[i] = view.getFloat64(off, false); off += 8; }
      else if (st >= 12 && (st & 1) === 0) {
        const len = (st - 12) / 2;
        values[i] = payload.slice(off, off + len);
        off += len;
      } else if (st >= 13) {
        const len = (st - 13) / 2;
        values[i] = this.textDecoder.decode(payload.subarray(off, off + len));
        off += len;
      } else values[i] = null;
    }
    return values;
  }
}

export function formatSqlitePreviewCell(value: SqliteValue, maxTextLength = 1024): string {
  if (value === null) return "NULL";
  if (value instanceof Uint8Array) return `[blob: ${value.byteLength} bytes]`;
  const text = String(value);
  return text.length > maxTextLength ? text.slice(0, maxTextLength) : text;
}
