// Reading an SQLite database file — only what it takes to list the tables and walk their rows.
// JW Library publications keep their text in one. Nothing else in the app needs SQL, so a full
// SQLite build (about a megabyte of WebAssembly) is not brought in for it.
//
// The file is a sequence of equal pages. A table is a B-tree: interior pages point at child pages,
// leaf pages hold the rows. A row is a record — a header listing the type of every value, then the
// values. A row too big for its page continues in a chain of overflow pages. The first page starts
// with the file header and holds the schema: one row per table with its root page and the
// CREATE TABLE text, which is where the column names come from.
// https://www.sqlite.org/fileformat2.html

export type SqlValue = number | string | Uint8Array | null;

interface Table {
  root: number;
  /** Lower-cased column names, in the order the values are stored. */
  columns: string[];
  /** The column that stands for the row id (declared INTEGER PRIMARY KEY); it is stored empty. */
  rowid: number;
  withoutRowid: boolean;
}

const MAGIC = 'SQLite format 3\u0000';
const CONSTRAINT = /^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i;
const unquote = (name: string) => name.trim().replace(/^["'`[]|["'`\]]$/g, '');

export function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

/** The pieces of a column list, cut at the commas that are not inside brackets or quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '[') quote = ']';
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Column names of a table, from the statement that created it. */
function parseColumns(sql: string): { columns: string[]; rowid: number; withoutRowid: boolean } {
  const clean = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const open = clean.indexOf('(');
  const close = clean.lastIndexOf(')');
  if (open < 0 || close < open) return { columns: [], rowid: -1, withoutRowid: false };
  const columns: string[] = [];
  const integer: boolean[] = [];
  let key: string | null = null;
  for (const part of splitTopLevel(clean.slice(open + 1, close))) {
    if (CONSTRAINT.test(part)) {
      // PRIMARY KEY("Id") written after the columns means the same as writing it next to the column.
      const named = /primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (named && !named[1].includes(',')) key = unquote(named[1].trim().split(/\s+/)[0]).toLowerCase();
      continue;
    }
    const m = /^("[^"]*"|`[^`]*`|\[[^\]]*\]|'[^']*'|[^\s(]+)\s*([\s\S]*)$/.exec(part);
    if (!m) continue;
    const name = unquote(m[1]).toLowerCase();
    const rest = m[2];
    const type = rest.split(/\b(?:primary|not|null|unique|check|default|collate|references|generated|constraint|as)\b/i)[0].trim();
    columns.push(name);
    integer.push(/^integer$/i.test(type));
    if (/\bprimary\s+key\b/i.test(rest)) key = name;
  }
  const at = key === null ? -1 : columns.indexOf(key);
  return { columns, rowid: at >= 0 && integer[at] ? at : -1, withoutRowid: /\)\s*(?:strict\s*,\s*)?without\s+rowid/i.test(clean.slice(close)) };
}

export class SqliteFile {
  private readonly view: DataView;
  private readonly pageSize: number;
  /** Bytes of a page that hold data; extensions may reserve some at the end. */
  private readonly usable: number;
  private readonly pageCount: number;
  private readonly text: TextDecoder;
  private readonly tables = new Map<string, Table>();

  constructor(private readonly bytes: Uint8Array) {
    if (!isSqlite(bytes)) throw new Error('це не база даних SQLite');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = this.view.getUint16(16);
    this.pageSize = size === 1 ? 65536 : size;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) throw new Error('пошкоджена база даних SQLite');
    this.usable = this.pageSize - bytes[20];
    this.pageCount = Math.floor(bytes.length / this.pageSize);
    const encoding = this.view.getUint32(56);
    this.text = new TextDecoder(encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8');

    const schema: Table = { root: 1, columns: ['type', 'name', 'tbl_name', 'rootpage', 'sql'], rowid: -1, withoutRowid: false };
    for (const row of this.scan(schema, [0, 1, 3, 4])) {
      const [type, name, root, sql] = row;
      if (type !== 'table' || typeof name !== 'string' || typeof root !== 'number' || root < 1 || typeof sql !== 'string') continue;
      this.tables.set(name.toLowerCase(), { root, ...parseColumns(sql) });
    }
  }

  has(table: string): boolean {
    return this.tables.has(table.toLowerCase());
  }

  /**
   * The rows of a table in the order of their row ids, each as an object with the columns asked for.
   * A column the table does not have reads as null, so the same code works across schema versions.
   * A table that is absent has no rows.
   */
  *rows<K extends string>(table: string, wanted: readonly K[]): Generator<Record<K, SqlValue>> {
    const found = this.tables.get(table.toLowerCase());
    if (!found) return;
    if (found.withoutRowid) throw new Error(`таблицю ${table} у цій базі даних прочитати не вдається`);
    const indexes = wanted.map((name) => found.columns.indexOf(name.toLowerCase()));
    for (const values of this.scan(found, indexes)) {
      const row = {} as Record<K, SqlValue>;
      wanted.forEach((name, i) => (row[name] = values[i]));
      yield row;
    }
  }

  private varint(at: number): [number, number] {
    const b = this.bytes;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      const c = b[at + i];
      value = value * 128 + (c & 0x7f);
      if (c < 0x80) return [value, i + 1];
    }
    // Nine bytes: the last one gives all eight of its bits. A number this long is a negative row
    // id, and it takes exact 64-bit arithmetic to read.
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 7n) | BigInt(b[at + i] & 0x7f);
    return [Number(BigInt.asIntN(64, (big << 8n) | BigInt(b[at + 8]))), 9];
  }

  private pageStart(page: number): number {
    if (page < 1 || page > this.pageCount) throw new Error('пошкоджена база даних SQLite');
    return (page - 1) * this.pageSize;
  }

  /** A row's bytes, gathered from its page and any overflow pages it continues in. */
  private payload(at: number, size: number): Uint8Array {
    const U = this.usable;
    const X = U - 35;
    if (size <= X) return this.bytes.subarray(at, at + size);
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (U - 4));
    const local = K <= X ? K : M;
    const out = new Uint8Array(size);
    out.set(this.bytes.subarray(at, at + local));
    let done = local;
    let next = this.view.getUint32(at + local);
    for (let guard = 0; next !== 0 && done < size && guard <= this.pageCount; guard++) {
      const start = this.pageStart(next);
      const take = Math.min(U - 4, size - done);
      out.set(this.bytes.subarray(start + 4, start + 4 + take), done);
      done += take;
      next = this.view.getUint32(start);
    }
    if (done < size) throw new Error('пошкоджена база даних SQLite');
    return out;
  }

  /** Every row under a page of a table's tree: the row id and the row's bytes. */
  private *cells(page: number, depth = 0): Generator<[number, Uint8Array]> {
    if (depth > 40) throw new Error('пошкоджена база даних SQLite');
    const start = this.pageStart(page);
    const head = start + (page === 1 ? 100 : 0);
    const kind = this.bytes[head];
    const count = this.view.getUint16(head + 3);
    if (kind === 13) {
      for (let i = 0; i < count; i++) {
        const at = start + this.view.getUint16(head + 8 + i * 2);
        const [size, a] = this.varint(at);
        const [rowid, b] = this.varint(at + a);
        yield [rowid, this.payload(at + a + b, size)];
      }
    } else if (kind === 5) {
      for (let i = 0; i < count; i++) yield* this.cells(this.view.getUint32(start + this.view.getUint16(head + 12 + i * 2)), depth + 1);
      yield* this.cells(this.view.getUint32(head + 8), depth + 1);
    } else throw new Error('пошкоджена база даних SQLite');
  }

  /** The values of the columns at `indexes` for every row; big values of other columns are stepped over. */
  private *scan(table: Table, indexes: number[]): Generator<SqlValue[]> {
    const last = Math.max(-1, ...indexes);
    for (const [rowid, record] of this.cells(table.root)) {
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const found = new Map<number, SqlValue>();
      // The record: a header with one type code per value, then the values in the same order.
      let p = 0;
      const number = () => {
        let value = 0;
        for (let n = 0; n < 9; n++) {
          const c = record[p++];
          value = value * 128 + (c & 0x7f);
          if (c < 0x80) break;
        }
        return value;
      };
      const headerSize = number();
      let body = headerSize;
      for (let column = 0; p < headerSize && column <= last; column++) {
        const code = number();
        const wanted = indexes.includes(column);
        let value: SqlValue = null;
        let length = 0;
        if (code === 0) length = 0;
        else if (code === 1) {
          length = 1;
          if (wanted) value = view.getInt8(body);
        } else if (code === 2) {
          length = 2;
          if (wanted) value = view.getInt16(body);
        } else if (code === 3) {
          length = 3;
          if (wanted) value = view.getInt8(body) * 65536 + view.getUint16(body + 1);
        } else if (code === 4) {
          length = 4;
          if (wanted) value = view.getInt32(body);
        } else if (code === 5) {
          length = 6;
          if (wanted) value = view.getInt16(body) * 4294967296 + view.getUint32(body + 2);
        } else if (code === 6) {
          length = 8;
          if (wanted) value = Number(view.getBigInt64(body));
        } else if (code === 7) {
          length = 8;
          if (wanted) value = view.getFloat64(body);
        } else if (code === 8 || code === 9) {
          if (wanted) value = code - 8;
        } else if (code >= 12) {
          // Even codes are bytes, odd ones text; the length is in the code itself.
          length = Math.floor((code - 12) / 2);
          if (wanted) {
            const piece = record.subarray(body, body + length);
            value = code % 2 ? this.text.decode(piece) : piece;
          }
        }
        body += length;
        if (wanted) found.set(column, value);
      }
      yield indexes.map((index) => {
        if (index < 0) return null;
        const value = found.get(index) ?? null;
        return value === null && index === table.rowid ? rowid : value;
      });
    }
  }
}
