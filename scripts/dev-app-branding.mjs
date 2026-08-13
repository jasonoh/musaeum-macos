#!/usr/bin/env node
/**
 * Make the dev Electron bundle present itself as Musaeum.
 *
 * macOS reads an app's name and icon from the *running bundle*, not from
 * `app.name` — so `npm run dev`, which runs node_modules/electron/dist/
 * Electron.app, says "Electron" and shows Electron's atom logo no matter what
 * the app calls itself. Three places this surfaces, each with its own source:
 *
 * - the menu bar's first title      → CFBundleName / CFBundleDisplayName
 * - the About panel's icon          → CFBundleIconFile (Resources/electron.icns)
 * - the Dock tile's label           → the *bundle directory's filename*
 *
 * The About panel is the reason the icon is patched here rather than left to
 * `app.dock.setIcon`: it draws NSApp.applicationIconImage, which comes from
 * the bundle, and `setAboutPanelOptions` has no macOS icon option (its
 * `iconPath` is Linux/Windows only). Packaged builds get all of this from
 * package.json + build/icon.icns and need none of this.
 *
 * Runs from postinstall (npm install re-extracts the stock bundle). Purely
 * cosmetic: it never fails an install, and the name written is the same
 * productName Electron already derives userData from, so no app path moves.
 */
import { execFileSync } from 'child_process'
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules/electron/dist')
const pathFile = join(root, 'node_modules/electron/path.txt')

if (process.platform !== 'darwin' || !existsSync(dist)) process.exit(0)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const appName = pkg.productName || pkg.name

// Read the packaged build's identifier from electron-builder.yml rather than
// keeping a second copy here — the whole point of the suffix below is that
// this bundle and the packaged one are distinguishable, which only holds if
// they are derived from the same string. A one-line regex beats adding a YAML
// parser for a single top-level scalar.
function packagedAppId() {
  try {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    return /^appId:[ \t]*['"]?([^'"\s#]+)/m.exec(yml)?.[1] ?? null
  } catch {
    return null
  }
}

// A `.dev` suffix keeps this bundle from colliding with the packaged build the
// way it collided with the stock one — see the identifier note below
const appId = `${packagedAppId() || 'org.theohs.musaeum'}.dev`

// ---------------------------------------------------------------------------
// The Dock tile's label is the bundle directory's filename, minus `.app`.
//
// Not CFBundleName, not CFBundleDisplayName, not CFBundleExecutable, not the
// bundle identifier, not LaunchServices. All five were measured reading
// "Musaeum" — `lsappinfo info -only name` and NSRunningApplication's
// `localizedName` both answered "Musaeum" — while the Dock tile still read
// "Electron". Copying the byte-identical patched bundle to a path macOS had
// never seen flipped the label to "Musaeum" when the copy was named
// `Musaeum.app` and back to "Electron" when it was named `Electron.app`.
// The directory name is the only input.
//
// So rename the bundle, and leave `Contents/MacOS/Electron` alone. An earlier
// attempt renamed the *executable* instead, which does nothing for the Dock
// and flips Electron's `app.isPackaged` to true in development (it is derived
// from `basename(process.execPath) !== 'electron'` and nothing else) — that
// sent `sidecarDir()` down the packaged branch and crashed startup with
// `spawn python3.12 ENOENT`. Renaming the directory costs none of that.
// ---------------------------------------------------------------------------
const stockBundle = join(dist, 'Electron.app')
const bundle = join(dist, `${appName}.app`)

try {
  if (existsSync(stockBundle)) {
    // A fresh `npm install` re-extracts Electron.app; if a previous run's
    // bundle is still sitting beside it, the freshly installed one wins
    if (existsSync(bundle)) rmSync(bundle, { recursive: true, force: true })
    renameSync(stockBundle, bundle)
  }
} catch (err) {
  console.warn(`dev-app-branding: could not rename the dev bundle — ${err.message}`)
}

const plist = join(bundle, 'Contents/Info.plist')
if (!existsSync(plist)) process.exit(0)

// Undo the old executable rename if this tree still carries one, so
// `app.isPackaged` reads correctly in dev again
const stockExe = join(bundle, 'Contents/MacOS/Electron')
const renamedExe = join(bundle, `Contents/MacOS/${appName}`)
try {
  if (!existsSync(stockExe) && existsSync(renamedExe)) renameSync(renamedExe, stockExe)
} catch {
  // Falls through to the path.txt write below, which is what actually launches
}

for (const [key, value] of [
  ['CFBundleName', appName],
  ['CFBundleDisplayName', appName],
  ['CFBundleExecutable', 'Electron'],
  // The Dock also resolves a tile through the *bundle identifier*, and every
  // unpatched node_modules/electron on the machine ships the same
  // `com.github.Electron` — including one in a stale git worktree of this very
  // project. Claiming our own id keeps the two from being confused for each
  // other in LaunchServices.
  ['CFBundleIdentifier', appId]
]) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
  } catch {
    // A missing key or a read-only bundle costs a menu title, nothing more
  }
}

// path.txt is the `electron` package's single source of truth for where the
// binary lives, so it has to follow the directory rename or nothing launches
try {
  writeFileSync(pathFile, `${appName}.app/Contents/MacOS/Electron`)
} catch (err) {
  console.warn(`dev-app-branding: could not update path.txt — ${err.message}`)
}

// Overwrite the bundle's icon in place rather than repointing CFBundleIconFile
// at our own file: the name in the plist is what a stock `npm install` will
// restore, so keeping it means the next install cleanly undoes this.
const icns = join(root, 'build/icon.icns')
const bundleIcns = join(bundle, 'Contents/Resources/electron.icns')
if (existsSync(icns) && existsSync(bundleIcns)) {
  try {
    copyFileSync(icns, bundleIcns)
    // macOS caches bundle icons by mtime; touching the .app is what gets
    // Finder and the Dock to look again instead of serving the stale atom
    const now = new Date()
    utimesSync(bundle, now, now)
  } catch {
    // Same bargain as the name above — cosmetic, never fatal
  }
}
