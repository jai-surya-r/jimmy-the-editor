# Third-party software

Software shipped with or built into Jimmy - The Editor, and its licences.

## FFmpeg (bundled with the desktop app)

- **What:** `ffmpeg` and `ffprobe` executables in `vendor/ffmpeg/<platform>-<arch>/`, fetched by
  `npm run fetch-ffmpeg` (tools/fetch-ffmpeg.mjs). Jimmy runs them as separate programs; it doesn't link to them.
- **Build:** BtbN/FFmpeg-Builds, release branch 8.1, "lgpl" variant (static). The exact version, archive checksum and
  source links are written to `SOURCE.txt` next to the binaries.
- **Licence:** GNU LGPL v3 or later (`LICENSE.txt` next to the binaries). The build has no GPL or non-free parts,
  so it has no x264/x265. CPU H.264 encoding uses OpenH264 instead.
- **Source:** https://github.com/FFmpeg/FFmpeg (commit named in `SOURCE.txt`). Build scripts and the versions of the
  libraries compiled in: https://github.com/BtbN/FFmpeg-Builds.
- **Not bundled on macOS yet:** no prebuilt LGPL build exists, so the Mac app uses an installed ffmpeg until one is
  built from source (planned with the Mac CI build).

### Libraries inside that FFmpeg build worth naming

- **OpenH264** (Cisco, BSD 2-clause): CPU H.264 encoder. It's compiled into the ffmpeg build, so Cisco's
  H.264 patent licence (which covers only Cisco's own prebuilt OpenH264 binaries) doesn't apply to it.
- **libvpx** (BSD): VP9 for transparent preview proxies.
- The rest are listed in BtbN's build scripts (all LGPL-compatible for the "lgpl" variant).

## Electron

- MIT licence (https://github.com/electron/electron). It includes Chromium and Node.js under their own licences,
  which Electron ships in `LICENSES.chromium.html` alongside the app.

## npm dependencies

- preact (MIT), htm (Apache-2.0), @xterm/xterm and @xterm/addon-fit (MIT), ws (MIT), @lydell/node-pty (MIT).

## Icons

- The stroke icons in `public/js/ui/icons.js` are drawn in the style of, and partly taken from,
  [Lucide](https://lucide.dev) (ISC licence; its notice, below, also covers the parts that come from [Feather](https://feathericons.com)).

  > ISC License. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
  > All other copyright (c) for Lucide are held by Lucide Contributors 2022.
  >
  > Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
  > granted, provided that the above copyright notice and this permission notice appear in all copies.
  >
  > THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING
  > ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL,
  > DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
  > WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
  > USE OR PERFORMANCE OF THIS SOFTWARE.
