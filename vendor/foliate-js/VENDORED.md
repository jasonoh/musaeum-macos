# foliate-js (vendored)

- **Upstream:** https://github.com/johnfactotum/foliate-js
- **Commit:** 78914aef4466eb960965702401634c2cb348e9b1
- **Vendored:** 2026-08-13
- **License:** MIT (see LICENSE in this directory)

## Do not install this from npm

Upstream states the library is not released on npm. The `foliate-js`
package on the registry is a single-version republish by an unrelated
maintainer, a year stale. Vendoring is upstream's own recommendation.

A committed copy was chosen over a git submodule so that a fresh clone
needs no `--recurse-submodules`, and so the exact reading engine is pinned
in our history. Updating means re-copying from the commit above.

## Dependencies

Bundled with the copy: `zip.js` and `fflate` are vendored under
`vendor/foliate-js/vendor/` (`zip.js`, `fflate.js`) and imported by
`view.js` via relative paths (`./vendor/zip.js`, `./vendor/fflate.js`) — no
npm install was needed.

## Local modifications

None. Keep it that way — any change here makes the next update a merge.
