#!/bin/sh
# Build the espeak-ng library the voice reader's pronunciation front end loads
# (spec D2, docs/superpowers/plans/2026-10-15-voice-reader-engine.md Task 2).
#
# Why this exists: the pip `espeakng-loader` wheel compiles a *build machine's*
# data path into its binary (`/Users/runner/work/...`), and espeak-ng calls exit()
# when it cannot read `phontab` there — measured on 0.1.51, 0.2.1 and 0.2.4, and no
# runtime path argument rescues it. A build of our own takes its data directory at
# run time (`espeak_Initialize`'s `path`), so the bundle is relocatable and nothing
# is baked in.
#
# Needs cmake, git and the network, and only to *build*: CMake's configure fetches a
# pinned `sonic` from GitHub even with USE_LIBSONIC=OFF. The app never needs any of
# it. GPL-3 (spec D2 → Licence); arm64 only, like the layout helper.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
version=1.52.0
sha256=bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23
work="${MUSAEUM_ESPEAK_WORK:-$root/helpers/.espeak-build}"
out="$root/helpers/bin/espeak"

mkdir -p "$work"
tarball="$work/espeak-ng-$version.tar.gz"
if [ ! -f "$tarball" ]; then
  curl -fsSL -o "$tarball" "https://github.com/espeak-ng/espeak-ng/archive/refs/tags/$version.tar.gz"
fi
echo "$sha256  $tarball" | shasum -a 256 -c -

rm -rf "$work/src" "$work/build" "$work/install"
mkdir -p "$work/src"
tar xzf "$tarball" -C "$work/src" --strip-components=1

cmake -S "$work/src" -B "$work/build" \
  -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DCMAKE_INSTALL_PREFIX="$work/install" \
  -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF \
  -DUSE_ASYNC=OFF -DUSE_SPEECHPLAYER=OFF -DUSE_KLATT=OFF
cmake --build "$work/build" -j 8
cmake --install "$work/build"

rm -rf "$out"
mkdir -p "$out/lib" "$out/share/espeak-ng-data"
# A plain file, not the symlink chain `cmake --install` makes: extraResources and
# codesign both prefer one. It is loaded by absolute path, so its install name
# (`@rpath/libespeak-ng.1.dylib`) never matters.
cp "$work/install/lib/libespeak-ng.1.52.0.dylib" "$out/lib/libespeak-ng.dylib"

# English only. The sentences we speak are English, and `ru_dict` alone is 8.5 of
# the full data's 19.8 MB; pruned, the whole bundle is ~1.4 MB.
data="$work/install/share/espeak-ng-data"
for entry in "$data"/*; do
  name="$(basename "$entry")"
  case "$name" in
    *_dict) [ "$name" = en_dict ] || continue ;;
  esac
  cp -R "$entry" "$out/share/espeak-ng-data/"
done
echo "built $out"
