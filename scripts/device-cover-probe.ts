/**
 * The device-cover probe — slice 1's Electron-side instrument.
 *
 * `npm test` runs Electron-as-Node, where `nativeImage` does not exist (the
 * `electron` alias is an inert mock), so one thing in slice 1 has no unit
 * decider at all: **the real codec's output**. This script is what decides it,
 * against the *shipped* `writeDeviceCover` rather than a copy of it — the same
 * division `scripts/theme-resolver-probe.ts` makes for the theme resolver.
 *
 *   npx esbuild scripts/device-cover-probe.ts --bundle --platform=node \
 *     --format=cjs --external:electron --outfile=out/probe-device-cover.cjs
 *   ./node_modules/.bin/electron out/probe-device-cover.cjs <book folder> [<book folder> …]
 *
 * Each argument is a real book folder (as `books/<id>` on the share). The probe
 * takes the folder's own `.azw3`/`.mobi` for the identity and its
 * `cover_full.jpg` for the jacket, plants the stale marker the device leaves
 * behind, and writes into a **throwaway directory standing in for the mount** —
 * it must never be pointed at a mounted device, and it never needs to be: the
 * rules under test are the device's, not its filesystem's.
 *
 * It prints measurements and asserts nothing, so its value is the numbers: the
 * entry's name (which carries the EXTH 113/501 that was read), the written byte
 * count against the device's measured 22–47 KB band, and the dimensions of the
 * JPEG that actually landed, read back off disk.
 *
 * Deliberately *not* measured here, because both need the device: whether it
 * renders the entry at all, and whether the fitted size is what it wants — a 2:3
 * jacket lands at 330×495 inside the 330×500 box rather than at the box's own
 * aspect. Those are readings for the next connect; see the spec's Risks 2.
 */
import { mkdtempSync, promises as fs, rmSync } from 'fs'
import { tmpdir } from 'os'
import { extname, join } from 'path'
import { app, nativeImage } from 'electron'
import {
  COVER_MARKER_SUFFIX,
  DEVICE_COVER_BOX,
  deviceCoverName,
  thumbnailsDir,
  writeDeviceCover
} from '../electron/main/services/device-covers'
import { readEmbeddedIdentity } from '../electron/main/services/mobi-header'

/** The device's own entries measured 22–47 KB on a real Kindle (2026-09-17). */
const DEVICE_BAND = { min: 22_000, max: 47_000 }
const MOBI_EXTENSIONS = ['.azw3', '.mobi']

const sourceIn = (files: string[]): string | undefined =>
  files.find((f) => MOBI_EXTENSIONS.includes(extname(f).toLowerCase()))
const coverIn = (files: string[]): string | undefined =>
  files.find((f) => f.toLowerCase() === 'cover_full.jpg')

/** The marker the device leaves beside an entry it failed to generate itself. */
async function plantMarker(bookDir: string, source: string, mount: string): Promise<void> {
  const identity = await readEmbeddedIdentity(join(bookDir, source))
  if (!identity?.uuid || !identity.cdetype) return
  const name = deviceCoverName(identity.uuid, identity.cdetype)
  await fs.writeFile(join(thumbnailsDir(mount), name + COVER_MARKER_SUFFIX), '')
}

async function probe(bookDir: string, mount: string): Promise<void> {
  const files = await fs.readdir(bookDir).catch((): string[] => [])
  const source = sourceIn(files)
  const cover = coverIn(files)

  console.log(`\n${bookDir}`)
  if (!source) {
    console.log('  no .azw3/.mobi in the folder — nothing to name an entry after')
    return
  }
  if (!cover) {
    console.log(`  ${source}: no cover_full.jpg — the app would write no entry`)
    return
  }

  const sourcePath = join(bookDir, source)
  const started = Date.now()
  const result = await writeDeviceCover({
    mountPath: mount,
    sourceFile: sourcePath,
    coverPath: join(bookDir, cover)
  })
  const elapsed = Date.now() - started

  if (!result.ok) {
    console.log(`  ${source}: no entry — ${result.kind} (${result.reason})`)
    return
  }

  const written = join(thumbnailsDir(mount), result.name)
  const bytes = await fs.readFile(written)
  const size = nativeImage.createFromPath(written).getSize()
  const inBand = bytes.length >= DEVICE_BAND.min && bytes.length <= DEVICE_BAND.max

  console.log(`  source   ${source} (${(await fs.stat(sourcePath)).size} B)`)
  console.log(`  entry    ${result.name}`)
  console.log(
    `  written  ${bytes.length} B — ${inBand ? 'in' : 'OUTSIDE'} the device band ${DEVICE_BAND.min}–${DEVICE_BAND.max}`
  )
  console.log(
    `  jpeg     ${bytes[0] === 0xff && bytes[1] === 0xd8 ? 'SOI present' : 'NOT A JPEG'} → ${size.width}×${size.height} (box ${DEVICE_COVER_BOX.width}×${DEVICE_COVER_BOX.height})`
  )
  console.log(`  marker   ${result.markerCleared ? 'cleared' : 'none was there'}`)
  console.log(`  took     ${elapsed} ms for the whole write`)
}

app.whenReady().then(async () => {
  const bookDirs = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const mount = mkdtempSync(join(tmpdir(), 'musaeum-probe-mount-'))
  await fs.mkdir(thumbnailsDir(mount), { recursive: true })

  for (const dir of bookDirs) {
    const source = sourceIn(await fs.readdir(dir).catch((): string[] => []))
    if (source) await plantMarker(dir, source, mount)
  }
  for (const dir of bookDirs) await probe(dir, mount)

  console.log('')
  rmSync(mount, { recursive: true, force: true })
  app.quit()
})
