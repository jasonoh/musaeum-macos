import { Buffer } from 'buffer'

/**
 * `.mobi`/`.azw3` files built the way real ones are, for tests that need a
 * header a parser *parses*.
 *
 * Mocking the parser instead would prove nothing about the offsets — the byte
 * layout is the thing under test (`services/mobi-header.ts`, derived in the
 * appendix of `docs/superpowers/specs/2026-09-17-device-presence-design.md`).
 * The layout here matches what a real device holds, including the traps
 * measured on one Kindle:
 *
 * - MOBI header lengths other than 232 (real files carry 232, 248, 256 and 264,
 *   so EXTH does not always start at `0x10 + 232`)
 * - EXTH values padded to a 4-byte boundary with NULs (3,788 of 36,259 EXTH
 *   records on that device end in one)
 * - record 0 past 16 KB (67 files on that device), which is why a fixed read
 *   window loses the title
 */

/** PalmDB header: the record count is its last `u16`. */
const PALMDB_HEADER_BYTES = 78
const RECORD_TABLE_ENTRY_BYTES = 8
const MAGIC_AT = 0x10
const DEFAULT_MOBI_HEADER_LENGTH = 232

export interface MobiFixtureOptions {
  /** The title the file carries inside itself. */
  title?: string
  /** EXTH 100. Omitted means the record is absent, as many files' are. */
  author?: string
  /** EXTH 113 — the identity the device names its cover cache after. */
  uuid?: string
  /** EXTH 501. */
  cdetype?: string
  /** Filler inside record 0, to push the title past a fixed read window. */
  filler?: number
  /** Pad EXTH values into a 4-byte boundary with NULs, as some writers do. */
  nulPadded?: boolean
  /** MOBI header length — where EXTH starts. Real files use 232 to 264. */
  headerLength?: number
  /** The EXTH flags word. The magic decides whether EXTH is really there. */
  exthFlag?: number
  /** Write an EXTH block at all: a header can carry the flag without one. */
  withExth?: boolean
}

/** One EXTH record: `u32` type, `u32` size (covering both fields), payload. */
function exthRecord(type: number, value: string, pad: boolean): Buffer {
  const payload = Buffer.from(value, 'utf8')
  const length = pad ? Math.ceil(payload.length / 4) * 4 : payload.length
  const record = Buffer.alloc(8 + length)
  record.writeUInt32BE(type, 0)
  record.writeUInt32BE(8 + length, 4)
  payload.copy(record, 8)
  return record
}

/** The EXTH block: magic, total length, count, then the records. */
function exthBlock(options: MobiFixtureOptions): Buffer {
  if (options.withExth === false) return Buffer.alloc(0)
  const pad = options.nulPadded ?? true
  const records = [
    options.author === undefined ? null : exthRecord(100, options.author, pad),
    options.uuid === undefined ? null : exthRecord(113, options.uuid, pad),
    options.cdetype === undefined ? null : exthRecord(501, options.cdetype, pad)
  ].filter((r): r is Buffer => r !== null)
  const body = Buffer.concat(records)

  const header = Buffer.alloc(12)
  header.write('EXTH', 0, 'latin1')
  header.writeUInt32BE(12 + body.length, 4)
  header.writeUInt32BE(records.length, 8)
  return Buffer.concat([header, body])
}

/** Record 0 — the whole book's header record, sized exactly as a real one. */
export function mobiRecordZero(options: MobiFixtureOptions): Buffer {
  const headerLength = options.headerLength ?? DEFAULT_MOBI_HEADER_LENGTH
  const exthAt = MAGIC_AT + headerLength
  const exth = exthBlock(options)

  const title = Buffer.from(options.title ?? '', 'utf8')
  const filler = Buffer.alloc(options.filler ?? 0, 0x20)
  const titleAt = exthAt + exth.length + filler.length

  const rec0 = Buffer.alloc(titleAt + title.length)
  // PalmDOC header, which the MOBI header follows
  rec0.writeUInt16BE(1, 0) // compression: none
  rec0.writeUInt16BE(0, 2)
  rec0.writeUInt32BE(title.length + 1, 4) // text length
  rec0.writeUInt16BE(1, 12) // text record count
  rec0.writeUInt16BE(4096, 14)

  rec0.write('MOBI', MAGIC_AT, 'latin1')
  rec0.writeUInt32BE(headerLength, 0x14)
  rec0.writeUInt32BE(2, 0x18) // mobi type: book
  rec0.writeUInt32BE(65001, 0x1c) // text encoding: utf-8
  rec0.writeUInt32BE(titleAt, 0x54) // full title offset, relative to record 0
  rec0.writeUInt32BE(title.length, 0x58)
  rec0.writeUInt32BE(options.exthFlag ?? 0x40, 0x80)

  exth.copy(rec0, exthAt)
  filler.copy(rec0, exthAt + exth.length)
  title.copy(rec0, titleAt)
  return rec0
}

/**
 * A whole book file: PalmDB header, record table, record 0, and one text
 * record — the smallest thing that is a file rather than a header.
 */
export function mobiFile(options: MobiFixtureOptions): Buffer {
  const rec0 = mobiRecordZero(options)
  const text = Buffer.from(`TEXT${'.'.repeat(60)}`, 'latin1')

  const count = 2
  const rec0At = PALMDB_HEADER_BYTES + count * RECORD_TABLE_ENTRY_BYTES
  const rec1At = rec0At + rec0.length

  const header = Buffer.alloc(PALMDB_HEADER_BYTES)
  header.write(options.title ?? 'Fixture', 0, 'latin1')
  header.writeUInt16BE(count, 76)

  const table = Buffer.alloc(count * RECORD_TABLE_ENTRY_BYTES)
  table.writeUInt32BE(rec0At, 0)
  table.writeUInt32BE(rec1At, RECORD_TABLE_ENTRY_BYTES)

  return Buffer.concat([header, table, rec0, text])
}
