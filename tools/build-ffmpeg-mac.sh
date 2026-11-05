#!/bin/bash
# Builds the LGPL ffmpeg the Mac app ships (there is no prebuilt one) into vendor/ffmpeg/darwin-<arm64|x64>/:
# ffmpeg, ffprobe, LICENSE.txt, SOURCE.txt. Same idea as the Windows build (tools/fetch-ffmpeg.mjs): LGPL v3, no GPL
# or non-free parts, so no x264. OpenH264 (BSD) for CPU H.264, libvpx (BSD) for VP9, VideoToolbox for the GPU.
# Everything is linked statically; only macOS system frameworks are used at run time.
#   bash tools/build-ffmpeg-mac.sh [arm64|x86_64]      (default: this Mac's architecture; the other one cross-compiles)
# Needs: Xcode command line tools, git, and `brew install nasm pkg-config`. Used by .github/workflows/mac.yml.
# NOT YET RUN: written on Windows; the first Mac CI run is its test.
set -euo pipefail

ARCH="${1:-$(uname -m)}"
case "$ARCH" in arm64) OUT=arm64; VPX_TARGET=arm64-darwin20-gcc ;; x86_64) OUT=x64; VPX_TARGET=x86_64-darwin20-gcc ;; *) echo "unknown arch $ARCH"; exit 1 ;; esac
FFMPEG_TAG=n8.1.3
OPENH264_TAG=v2.6.0
VPX_TAG=v1.15.2

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/jimmy-ffmpeg-$ARCH"
PREFIX="$WORK/prefix"
DEST="$ROOT/vendor/ffmpeg/darwin-$OUT"
JOBS="$(sysctl -n hw.ncpu)"
export MACOSX_DEPLOYMENT_TARGET=11.0
CROSS=()
[ "$ARCH" != "$(uname -m)" ] && CROSS=(--enable-cross-compile --target-os=darwin)
mkdir -p "$WORK" "$PREFIX"
cd "$WORK"

# OpenH264, static only (its shared library is removed so ffmpeg links the static one)
[ -d openh264 ] || git clone --depth 1 -b "$OPENH264_TAG" https://github.com/cisco/openh264.git
make -C openh264 -j"$JOBS" OS=darwin ARCH="$ARCH" PREFIX="$PREFIX" install
rm -f "$PREFIX"/lib/libopenh264*.dylib

# libvpx, static
[ -d libvpx ] || git clone --depth 1 -b "$VPX_TAG" https://chromium.googlesource.com/webm/libvpx
(cd libvpx && ./configure --prefix="$PREFIX" --target="$VPX_TARGET" --enable-static --disable-shared \
  --disable-examples --disable-unit-tests --disable-docs --enable-vp9-highbitdepth && make -j"$JOBS" && make install)

# FFmpeg
[ -d ffmpeg ] || git clone --depth 1 -b "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git ffmpeg
cd ffmpeg
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" --arch="$ARCH" ${CROSS[@]+"${CROSS[@]}"} \
  --cc="clang -arch $ARCH" --cxx="clang++ -arch $ARCH" \
  --enable-version3 --disable-gpl --disable-nonfree --disable-debug --disable-doc --disable-ffplay \
  --enable-static --disable-shared --pkg-config-flags=--static \
  --disable-autodetect --enable-zlib --enable-bzlib \
  --enable-libopenh264 --enable-libvpx --enable-videotoolbox --enable-audiotoolbox \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" --extra-version=jimmy
make -j"$JOBS"

mkdir -p "$DEST"
cp ffmpeg ffprobe "$DEST/"
cp COPYING.LGPLv3 "$DEST/LICENSE.txt"
COMMIT="$(git rev-parse --short=10 HEAD)"
cat > "$DEST/SOURCE.txt" <<EOF
FFmpeg $FFMPEG_TAG ($COMMIT), built by tools/build-ffmpeg-mac.sh for $ARCH
Licence: LGPL v3 or later (--enable-version3 --disable-gpl --disable-nonfree); see LICENSE.txt.
Source code: https://github.com/FFmpeg/FFmpeg/tree/$COMMIT
Built in: OpenH264 $OPENH264_TAG (BSD, https://github.com/cisco/openh264), libvpx $VPX_TAG (BSD, https://chromium.googlesource.com/webm/libvpx)
EOF
echo "→ $DEST"
