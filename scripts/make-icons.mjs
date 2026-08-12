#!/usr/bin/env node
/**
 * Build build/icon.icns from build/icon.png.
 *
 * Uses macOS's own `sips` and `iconutil` rather than a node image library —
 * the .icns format is macOS-only anyway, so a dependency that can write it
 * buys nothing over the tools already on the machine.
 *
 * build/icon.icns is where electron-builder looks by default, so packaging
 * picks it up with no config once it's added. The dev Dock icon does NOT come
 * from here — see `app.dock.setIcon` in electron/main/index.ts.
 *
 * Run after replacing build/icon.png: `npm run icons`
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'build/icon.png')
const iconset = join(root, 'build/icon.iconset')
const icns = join(root, 'build/icon.icns')

if (process.platform !== 'darwin') {
  console.log('make-icons: not macOS, skipping')
  process.exit(0)
}
if (!existsSync(src)) {
  console.error(`make-icons: missing ${src} — put a 1024x1024 PNG there first`)
  process.exit(1)
}

// Guard the source size: sips will happily upscale, which produces a blurry
// icon that looks fine in the Dock and bad everywhere else.
const dims = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], {
  encoding: 'utf8'
})
const [width, height] = [...dims.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]))
if (width !== height) throw new Error(`icon.png must be square, got ${width}x${height}`)
if (width < 1024) throw new Error(`icon.png must be at least 1024x1024, got ${width}x${width}`)

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })

// Each base size ships at 1x and 2x; the 2x file is the next size up under a
// name macOS reads as retina, which is why 32/64/256/512 are rendered twice.
for (const size of [16, 32, 128, 256, 512]) {
  for (const [scale, name] of [
    [1, `icon_${size}x${size}.png`],
    [2, `icon_${size}x${size}@2x.png`]
  ]) {
    const px = size * scale
    execFileSync('/usr/bin/sips', ['-z', String(px), String(px), src, '--out', join(iconset, name)], {
      stdio: 'ignore'
    })
  }
}

execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns])
rmSync(iconset, { recursive: true, force: true })
console.log(`make-icons: wrote ${icns} from ${width}x${width} source`)
