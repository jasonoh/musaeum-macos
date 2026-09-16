# Vendored provider schemes

Third-party palette files, committed as data — the same category as
`vendor/foliate-js/`: never edited here, and updated by re-copying from the
source below. `../builtin/` is the built-in scheme corpus (slice 4's picker
content); four of its members are also the base16 fixtures slice 2's derivation
tests assert against, so no second copy of a scheme exists in the repo. The two
`.itermcolors` files under `test/fixtures/theme/` are the iTerm2 half of that
corpus.

## base16 — `builtin/*.yaml` (13 files)

- **Upstream:** https://github.com/tinted-theming/schemes
- **Ref:** `spec-0.11`, commit `7cda828e3ed8bca190857bdcfe6bac84db690780`
- **Path upstream:** `base16/<same filename>`
- **License:** MIT (collection). Per-scheme copyright belongs to each scheme's
  own author — the collection's LICENSE says so explicitly — and every file's
  `author:` header carries that attribution. Nothing here is redistributed as a
  theme of our own making; the app derives its own tokens from these palettes.
- **Verified:** on 2026-09-15 all thirteen files were fetched from the ref above
  and compared byte-for-byte with the committed copies — identical. (The spec at
  `docs/superpowers/specs/theming.md` §7 recorded this as *not verified*; it is
  verified now, in the strict direction.)

`catppuccin-latte` · `catppuccin-mocha` · `dracula` · `everforest-dark-hard` ·
`gruvbox-dark-hard` · `gruvbox-light-soft` · `kanagawa` · `nord` ·
`rose-pine-moon` · `solarized-dark` · `solarized-light` · `tokyo-night-dark` ·
`tokyo-night-light`

**Count note.** The spec's file-budget table (§5) says `builtin/*.yaml` (10).
The curated set on disk is 13, and the whole set was vendored rather than an
arbitrary ten. Four are light, nine dark — the spec's §6.5 claim that the curated
set is "deliberately half light" does not hold for this set, which matters
because light variants are where the derivation is least tested
(`tasks.md`, Theming → slice 2).

## iTerm2 — `test/fixtures/theme/*.itermcolors` (2 files)

- **Upstream:** https://github.com/mbadolato/iTerm2-Color-Schemes
- **Ref:** `master`, commit `1a3e1d298b0a102d53333f1a03cb5234e7f9dae8`
- **Path upstream:** `schemes/Gruvbox Dark Hard.itermcolors`,
  `schemes/Nord.itermcolors`
- **License:** MIT (collection), with the same per-theme copyright carve-out —
  the corpus's LICENSE states that each theme's copyright belongs to its author.
- **Verified:** on 2026-09-15 both files were fetched and their component values
  compared slot by slot against the committed copies via `plistlib` — 27 and 26
  colour slots, zero differing components. The only change is the filename
  (`gruvbox.itermcolors`, `nord.itermcolors`), which keeps the fixture names
  aligned with their base16 counterparts.

## Local modifications

None, in either directory. Keep it that way: these files are the fixture corpus
and the built-in corpus at once, so an edit here changes what the derivation
tests prove. `npm run format` would rewrite the YAML in prettier's style — both
directories are listed in `.prettierignore` for exactly this reason.
