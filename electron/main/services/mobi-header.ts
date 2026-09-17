import { promises as fs } from 'fs'

/**
 * What a `.mobi`/`.azw3` file says about *itself*: the title and author in its
 * own header, plus the two identity fields the device keys its cover cache on.
 *
 * Presence used to match `sanitizeTitle(book.title)` against the *stems* of the
 * files on a device, which only sees books Musaeum wrote itself — every other
 * tool names its files its own way (Calibre writes
 * `{author_sort}/{title} - {authors}.ext`), and titles get mangled in transit
 * ("Algebraist, The", "Homo Deus_"). Measured on a real Kindle: the filename
 * rule recognized 86 of 1,555 book files, the title inside each file reaches
 * 1,343. See `docs/superpowers/specs/2026-09-17-device-presence-design.md`.
 *
 * Offsets are the MOBI/PalmDB layout; the appendix of that spec derives each
 * one. Two of them are load-bearing enough to restate here:
 *
 * - **Record 0 is sized from the record table, never guessed.** A fixed window
 *   (16 KB is the tempting one) loses the title on any book whose EXTH — blurb,
 *   tag list — pushes record 0 past it; measured, ~30 files on one device.
 * - **EXTH presence is decided by the magic, not by the flag.** The flag is not
 *   always set even when EXTH follows, and a header with no EXTH means "no
 *   author", not "unreadable" — the title alone carries the book when the
 *   library holds exactly one book with that title.
 */

/** The whole PalmDB header: the record count is the last `u16` of it. */
const PALMDB_HEADER_BYTES = 78
const RECORD_TABLE_ENTRY_BYTES = 8
const RECORD_COUNT_AT = 76

const MOBI_MAGIC = 'MOBI'
const MOBI_MAGIC_AT = 0x10
const MOBI_HEADER_LENGTH_AT = 0x14
const FULL_TITLE_OFFSET_AT = 0x54
const FULL_TITLE_LENGTH_AT = 0x58

/** Where EXTH starts, when it starts: the MOBI header length is in the header. */
const EXTH_AT = (headerLength: number): number => MOBI_MAGIC_AT + headerLength
const EXTH_MAGIC = 'EXTH'
const EXTH_HEADER_BYTES = 12

/** EXTH record types worth keeping. 100 and 113/501 are read for different reasons. */
const EXTH_AUTHOR = 100
const EXTH_UUID = 113
const EXTH_CDETYPE = 501

/** The title length bound both this and the census instrument agree on. */
const MAX_TITLE_BYTES = 1024

/** Extensions whose identity lives in a MOBI header. `.kfx` has none we can read. */
const MOBI_EXTENSIONS = ['.mobi', '.azw3', '.azw']

export interface EmbeddedIdentity {
  title: string | null
  author: string | null
  /** EXTH 113 — the identity the device's cover cache is named after, not a book key. */
  uuid: string | null
  /** EXTH 501 — `EBOK` and friends. */
  cdetype: string | null
}

/** Whether this path's extension is one whose identity we can read. */
export function isMobiFamily(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot > 0 && MOBI_EXTENSIONS.includes(path.slice(dot).toLowerCase())
}

/**
 * The identity in an already-read record 0, or `null` when it is not a MOBI
 * header at all. Pure: the fixture tests exercise it directly, which is the only
 * thing that proves the offsets.
 */
export function parseMobiRecordZero(rec0: Buffer): EmbeddedIdentity | null {
  if (rec0.length < MOBI_MAGIC_AT + 4) return null
  if (rec0.toString('latin1', MOBI_MAGIC_AT, MOBI_MAGIC_AT + 4) !== MOBI_MAGIC) return null

  const headerLength = rec0.readUInt32BE(MOBI_HEADER_LENGTH_AT)
  const exth = readExthRecords(rec0, headerLength)
  return {
    title: readFullTitle(rec0),
    author: exth.get(EXTH_AUTHOR) ?? null,
    uuid: exth.get(EXTH_UUID) ?? null,
    cdetype: exth.get(EXTH_CDETYPE) ?? null
  }
}

/**
 * Read a book file's own identity.
 *
 * Returns `null` when the file was read and simply is not a MOBI book — a KFX
 * stub, an odd header, a bare file. That is a fact about the file worth caching:
 * the filename rule is all it offers, and re-opening it on every pass buys
 * nothing.
 *
 * **Throws** when the file could not be read at all (it is gone, the volume was
 * unplugged mid-pass, the mount returned an I/O error — all observed on a real
 * Kindle). That is not a fact about the book, and it must not be recorded as one:
 * a transient failure cached as "no title" would leave that book reading as
 * absent until the file next changed size.
 */
export async function readEmbeddedIdentity(path: string): Promise<EmbeddedIdentity | null> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(path, 'r')

    const header = await readExactly(handle, 0, PALMDB_HEADER_BYTES)
    if (!header) return null
    const count = header.readUInt16BE(RECORD_COUNT_AT)
    // Record 0's length is the distance to record 1, so one record is not enough
    // to locate it — the census instrument refuses that file the same way
    if (count < 2) return null

    const table = await readExactly(handle, PALMDB_HEADER_BYTES, RECORD_TABLE_ENTRY_BYTES * 2)
    if (!table) return null
    const start = table.readUInt32BE(0)
    const end = table.readUInt32BE(RECORD_TABLE_ENTRY_BYTES)
    if (end <= start) return null

    const rec0 = await readExactly(handle, start, end - start)
    return rec0 ? parseMobiRecordZero(rec0) : null
  } finally {
    // macOS's SMB client returns EBADF closing some files it has just read in
    // full — the same quirk `transfer-queue`'s copy swallows. It says nothing
    // about what we read, and this is a read-only handle either way.
    await handle?.close().catch(() => undefined)
  }
}

/** Exactly `length` bytes from `position`, or `null` if the file ends first. */
async function readExactly(
  handle: fs.FileHandle,
  position: number,
  length: number
): Promise<Buffer | null> {
  if (length <= 0) return null
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read)
    if (bytesRead === 0) return null
    read += bytesRead
  }
  return buffer
}

/**
 * The MOBI header's full-title field: an offset and a length, both relative to
 * record 0. Its length is in bytes, so a title that is not ASCII decodes here
 * and only here.
 */
function readFullTitle(rec0: Buffer): string | null {
  if (rec0.length < FULL_TITLE_LENGTH_AT + 4) return null
  const offset = rec0.readUInt32BE(FULL_TITLE_OFFSET_AT)
  const length = rec0.readUInt32BE(FULL_TITLE_LENGTH_AT)
  if (length === 0 || length >= MAX_TITLE_BYTES) return null
  if (offset + length > rec0.length) return null
  return rec0.toString('utf8', offset, offset + length)
}

/**
 * EXTH records by type, last one winning. Returns empty for a header with no
 * EXTH — the caller reads that as "no author", never as a broken book.
 */
function readExthRecords(rec0: Buffer, headerLength: number): Map<number, string> {
  const records = new Map<number, string>()
  const pos = EXTH_AT(headerLength)
  if (rec0.length < pos + EXTH_HEADER_BYTES) return records
  if (rec0.toString('latin1', pos, pos + 4) !== EXTH_MAGIC) return records

  const length = rec0.readUInt32BE(pos + 4)
  const count = rec0.readUInt32BE(pos + 8)
  const end = Math.min(pos + length, rec0.length)

  let p = pos + EXTH_HEADER_BYTES
  for (let i = 0; i < count && p + RECORD_TABLE_ENTRY_BYTES <= end; i++) {
    const kind = rec0.readUInt32BE(p)
    const size = rec0.readUInt32BE(p + 4)
    // The size covers the type and length fields too, and a record shorter than
    // them would walk backwards through the buffer
    if (size < RECORD_TABLE_ENTRY_BYTES) break
    const value = rec0.toString('utf8', p + RECORD_TABLE_ENTRY_BYTES, Math.min(p + size, rec0.length))
    if (kind === EXTH_AUTHOR || kind === EXTH_UUID || kind === EXTH_CDETYPE) records.set(kind, value)
    p += size
  }
  return records
}
