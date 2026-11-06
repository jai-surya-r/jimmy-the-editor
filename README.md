# Jimmy - The Editor

A local video editor built around Claude. Every project is a folder holding a `project.json` timeline. Claude Code edits that file, and the editor shows each change live. You can move, trim and restyle things by hand, export versions, and review them frame by frame in a Frame.io-style review screen.

## Install and start

Download it from [Releases](https://github.com/jai-surya-r/jimmy-the-editor/releases/latest).

- **Windows:** run `Jimmy-The-Editor-Setup-<version>.exe`, then open **Jimmy - The Editor** from the Start menu. It isn't signed: if Windows says it protected your PC, click **More info › Run anyway**.
- **macOS:** open the dmg for your Mac (`-mac-arm64` for Apple silicon, `-mac-x64` for Intel) and drag the app to Applications. It isn't notarized by Apple: the first time, macOS won't open it; go to System Settings › Privacy & Security and click **Open Anyway**.
- The app brings its own ffmpeg and browser engine. For the built-in Claude chats and terminal, install [Claude Code](https://claude.com/claude-code) and sign in from Settings › Accounts.
- Everything stays on this computer: the editor talks to its own server on 127.0.0.1 only.
- Projects live in the app's data folder by default. You can also open any folder with **Open folder…**

**From the source:** `npm install`, then `npm run app` (the desktop app) or `npm start` (the server alone, opened in a browser; this is what most tests use). Needs Node.js 20+.

## The screen

**Edit mode**
- **Project bin** (left): folders, media and sequences. Upload files, or use the **link** button to import from disk without copying. Drag items into folders or onto the timeline. Double-click a clip to preview it and mark in/out points.
- **Program viewer** (centre): the live composite. Click a layer to select it, drag to move, drag a corner to scale, drag the top handle to rotate. Layers snap to the frame centre and edges.
- **Inspector** (right): timing, transform, crop, blend mode, text styling, color and effects, transitions and audio. Drag any number to scrub it (Shift ×10, Alt fine), or click it to type. The clock icon animates a property, adding keyframes at the playhead.
- **Timeline** (bottom): sequence tabs, video and audio tracks (eye, mute, solo, lock), trim by dragging clip edges, razor (C), snapping (S), linked audio and video, markers (M), in/out (I/O), audio fade handles, filmstrips and waveforms.
- **Claude panel** (far right): a real Claude Code terminal running in that project's folder. Each tab has its own session. Use *Continue last chat*, *New chat* or *Pick a past chat*, and choose which Claude account it runs as.

**Review mode**: each export becomes a version. Comment at a timecode (or over a range), draw arrows, boxes or freehand on the frame, reply, resolve, set a status (In review / Changes requested / Approved), and compare two versions side by side or with a wipe. **Send to Claude** types the open notes into the project's Claude session, with instructions to fix them, reply, and render a new version.

**Claude accounts**: the lock button in the Claude panel (or Settings › Accounts…) shows every Claude profile and whether it is signed in. Sign in, sign out, or add another account (for example work and personal); signing in opens Claude's own page in the browser. Accounts are independent, and each project uses only the one picked for it.

**Render bar**: the thin line under the timeline ruler is green where the sequence is already pre-rendered and amber where it isn't yet.

**Tabs**: open several projects at once, each with its own Claude session. The tab dot glows while Claude is running and pulses when Claude edits the project.

## Working with Claude

Each project folder gets a `CLAUDE.md` that explains the project format and the `vedit` helper, so any Claude Code chat opened in that folder (built-in or your own terminal) knows how to edit it. Useful things to ask:

- "Cut the dead air out of the A-roll and add captions from this SRT."
- "Look at the frame at 12s — is the title readable?" (Claude runs `vedit frame 12` and reads the PNG.)
- "Address my review comments." (Or press **Send to Claude** in Review.)

Claude sees what you're looking at (current sequence, playhead and selected clips) in `.claude-edit/ui.json`, so "this clip" and "here" work. **Ctrl+Z undoes Claude's edits too.**

`vedit` commands (on PATH inside the built-in terminal):

```
vedit status                 overview of media, sequences, tracks and clips
vedit frame <sec>            render one frame to PNG
vedit render [--final|--draft]   export an MP4 → new review version (full quality if pre-rendered, else a draft)
vedit comments --open        review notes (with --frames: frame grabs with your drawings boxed)
vedit reply <id> "…" --resolve
vedit import <files> [--folder Name]
vedit validate
vedit motion new|set|frame|render|batch|list   motion graphics (below)
```

## Motion graphics

A motion graphic is an HTML page (CSS animations, GSAP, canvas, Lottie, three.js…) that the editor renders frame by frame into a **transparent video clip**. The HTML stays in the project (`motion/`, or `1_Assets/4_Overlays` in projects made with Jimmy's template), so it's never a dead render:

- Create one with the ✦ button in the Project panel (starter lower third or any .html file), or ask Claude (`vedit motion new`).
- Values the page declares in `<script type="application/json" id="motion">{ "params": { … } }</script>` become fields in the Inspector. Edit them (or the HTML itself) and it re-renders automatically; renders are cached, so undo is instant.
- The Inspector shows a live preview at the playhead while a render runs. Exports wait for pending renders.
- Pages may load local files and libraries from cdnjs, jsDelivr, unpkg, esm.sh and Google Fonts; nothing else on the network.
- `vedit motion batch <id> rows.csv` makes one graphic per row (e.g. a lower third for every speaker).

Export formats: H.264 MP4, ProRes 422 HQ, and ProRes 4444 with alpha (transparent background) for handing graphics to Premiere/Resolve.

## Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| Space | play / pause | J K L | shuttle back / stop / forward |
| ← → | previous / next frame (Shift: 1 second) | ↑ ↓ | previous / next edit point |
| Home / End | start / end | Ctrl+K | split at playhead |
| C / V | razor / select tool | S | toggle snapping |
| T | add text | M | add marker |
| I / O | set in / out (Alt+X clears) | Del / Shift+Del | delete / ripple delete |
| Ctrl+C / X / V | copy / cut / paste | Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| Ctrl+E | export | Ctrl+J | show / hide the Claude panel |
| = / − / \ | zoom in / zoom out / fit timeline | (Review) C | jump to the comment box |

## How it works

- `server/`: Node server. It handles project storage with live two-way file sync, media probing, thumbnails, waveforms and proxies (`.cache/`), the embedded terminals (node-pty), and exports.
- `public/js/core/compositor.js` draws every frame. The live viewer and the exporter both use it, so exports match the preview.
- Exports: ffmpeg decodes the original media frame-accurately, a headless Chrome/Edge composites the frames, and ffmpeg encodes H.264 or ProRes and mixes the audio. Files land in the project's `renders/` folder.
- Chunks (`server/chunks.js`, `server/render.js`): the timeline is rendered in chunks of about two seconds, several side by side, each kept as its own file named after a fingerprint of everything that affects its picture. An export stitches the chunk files and mixes the audio, so only chunks that changed since the last export are rendered again. Frame checks (`vedit frame`) have their own worker and never wait behind an export; several exports share the workers in turns.
- Background pre-rendering (`server/prerender.js`): while a project is open, changed chunks are rendered a few seconds after each edit, so an export is mostly a stitch. It pauses while you play or scrub (and on battery), and gives way to exports. Settings sets how much of the computer this may use (25 / 50 / 70 / 100%) and the size cap of the chunk cache. Chunks are removed when they no longer match the timeline (after 30 minutes, so undo stays instant), when a version of that sequence is marked Approved, when the cache goes over its cap (least recently used first), or by hand in Settings › Storage.
- Formats the browser can't play (HEVC, ProRes and so on) get a lightweight preview proxy automatically. Exports always use the originals.
- Motion graphics (`server/motion.js`): a headless Chrome/Edge loads the page with `public/motion/runtime.js`, which replaces the page's clock so every frame is captured at an exact time. Frames become a ProRes 4444 master (what exports read) and a VP9-alpha preview proxy in one ffmpeg pass.

## Troubleshooting

- **"project.json can't be read"**: the file has a JSON syntax error, usually from a half-finished edit. Editing pauses so nothing gets overwritten. Click *Ask Claude to fix* or *Restore last good version*.
- **Media offline**: the file moved or was renamed. Update its `path` in `project.json` (or ask Claude to), then use *Re-scan media files* in the bin's ⋯ menu.
- **Exports never start**: Chrome or Edge must be installed for headless rendering. Otherwise keep the editor open and it renders in the background of that page.

## Licence

Jimmy - The Editor is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](LICENSE), version 3 or (at your option) any later version. It comes with no warranty.
Copyright © 2026 Jai Surya R.

The software bundled with it, and the licences it comes under, are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
The name "Jimmy - The Editor" and its logo are not covered by the GPL: forks are welcome, under a name and logo of
their own.

Jimmy is an independent project, not made by or affiliated with Anthropic. Claude and Claude Code are trademarks of
Anthropic, PBC.
