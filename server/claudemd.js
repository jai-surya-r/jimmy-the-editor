import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, toPosix, writeFileAtomic } from './util.js';
import { layoutFor } from './layout.js';

const START = '<!-- claude-edit:start -->';
const END = '<!-- claude-edit:end -->';

export function managedBlock(dir) {
  const L = layoutFor(dir);
  const rel = (p) => toPosix(path.relative(dir, p));
  const ui = L.template ? rel(path.join(L.files, 'ui.json')) : '.claude-edit/ui.json';
  const cli = `"${toPosix(path.join(APP_DIR, 'bin', process.platform === 'win32' ? 'vedit.cmd' : 'vedit'))}"`;
  return `${START}
<!-- Managed by Jimmy; this block is regenerated automatically. Put your own notes outside it. -->
# Jimmy - The Editor project

This folder is a video-editing project for **Jimmy - The Editor** ("Jimmy"), the user's local video editor (\`vedit\` finds it).
The user watches the timeline and the preview live: when you save \`project.json\` the editor reloads it within a
second, and changes the user makes in the editor are written back here. **Re-read \`project.json\` right before
editing** — the user may have changed it since you last looked.

## Files
| path | contents |
|---|---|
| \`project.json\` | the edit: media bin, folders, sequences (tracks, clips, keyframes, transitions, text) |
| \`reviews.json\` | rendered versions and the user's timecoded review comments (some with drawings) |
${L.template ? `| \`${rel(L.upload('video'))}/\`, \`${rel(L.upload('audio'))}/\`, \`${rel(L.upload('image'))}/\` | where uploaded media lands (this folder follows **Jimmy's template** — media may also be referenced anywhere on disk, e.g. \`4_Footage/A_Roll\`) |
| \`${rel(L.renders)}/\` | exported videos — each export becomes a review version. All of \`3_Exports/\` shows in Review |
| \`1_Assets/\` | .ttf/.otf/.woff2 files anywhere in here are project fonts (use the file name without extension as \`style.font\`) |
| \`${ui}\` | what the user is looking at: sequence, playhead time, selected clip ids (\`${rel(L.files)}/\` is the editor's own folder — never edit) |
| \`${rel(L.motionRenders)}/\` | rendered motion graphics (made by the editor from their HTML sources — never edit) |
| \`4_Footage/A_Roll/Proxies/\`, \`4_Footage/B_Roll/Proxies/\` | the editor's proxies of that footage — never edit |

**Jimmy's template rule: never create new folders in this project.** Put files only in the existing template folders.` : `| \`media/\` | media uploaded into the project (media may also be referenced anywhere on disk) |
| \`renders/\` | exported videos — each export becomes a review version |
| \`fonts/\` | .ttf/.otf/.woff2 files; use the file name without extension as \`style.font\` |
| \`.claude-edit/ui.json\` | what the user is looking at: sequence, playhead time, selected clip ids |
| \`.cache/\` | thumbnails, waveforms, proxies — never edit |`}

## Tools — \`vedit\`
\`vedit\` is on PATH in every Claude session the editor starts (its chat panel and its terminal): use plain \`vedit\` there.
Only in a Claude session started outside the editor run \`${cli} <command>\` from this folder.
- \`vedit status\` — compact overview of every sequence/track/clip with times, plus what the user is looking at
- \`vedit probe <file>\` — media info (duration, resolution, fps, audio)
- \`vedit import <file...> [--folder "Name"] [--copy]\` — add media to the bin (metadata is filled in automatically)
- \`vedit transcript <media id>\` — the saved transcript of a clip, as timed lines. **Run it before transcribing anything**:
  transcripts are kept by Jimmy (in its cache, found by the file's contents, from any project or path). Only if it says
  there is none, transcribe, then keep it at once with \`vedit transcript save <media id> <file.json|.srt|.vtt>\`
  (JSON: \`{ "language", "segments": [{ "start", "end", "text", "words"? }] }\`, seconds). \`vedit transcript list\` shows which clips have one
- \`vedit frame <time…> [--seq <id>] [--out frame.png]\` — render composited frames to PNG; **Read the PNG to check your work**.
  Give several times in one call (\`vedit frame 2 5.5 9\`) rather than one command per frame.
  The PNG is check-sized (540p: 960×540, or 540×960 for vertical); add \`--full\` only when you must inspect fine detail at full resolution
- \`vedit render [--seq <id>] [--range 5-12.5]\` — export a quick review MP4; it becomes a new review version. The editor
  pre-renders the sequences the user turned pre-rendering on for, so this is full quality when that is ready and a quicker **draft** otherwise.
  Drafts are at most 1080p (a 4K sequence drafts at 1920×1080; smaller sequences keep their size); that is automatic, never ask for more.
  Always render this way. Only add \`--final\` (always full quality, can be slow) when the user explicitly asks for a final/high-quality export
- \`vedit comments [--open] [--version v3]\` — review comments with timecodes
- \`vedit reply <commentId> "text" [--resolve]\` — answer and/or resolve a review comment. Keep a reply to one short line
  (e.g. "Trimmed the pause, title moved up"), never paragraphs
- \`vedit validate\` — check project.json for problems
- \`vedit motion …\` — motion graphics (see below); \`vedit render --format hevc|prores|prores422|proreslt|proresproxy|prores4444o|prores4444\` exports H.265 or ProRes (.mov; prores4444 keeps alpha); for a delivery spec add \`--mbps 10 [--cbr]\`, \`--height 1080\` (the shorter side) or \`--width\`, \`--fps 25\`, \`--mov\`, \`--audio aac320|pcm24|none\`, \`--sample-rate 44100\`
- \`vedit link <sequence id|name>\` — link this chat to the sequence it works on (see below); \`vedit link --none\` unlinks

## Chats and sequences
The user often runs several chats on this project at once, each working on its own sequence. The editor links a chat
to one sequence: the user's messages about that sequence and its review comments then come to that chat.
- When the user asks you to make a new sequence to work in (or to work on one sequence), run \`vedit link <sequenceId>\`
  right after creating or choosing it.
- A message that starts with a \`<jimmy-sequence>\` note comes to a chat linked to that sequence: change **only that
  sequence** in project.json (adding media to the bin is fine) and leave every other sequence exactly as it is — other
  chats are editing them at the same time. Re-read project.json right before each edit, and use small Edits, never a full rewrite.
- In a linked chat, \`vedit status\`, \`vedit frame\`, \`vedit render\` and \`vedit comments\` default to the linked sequence
  (\`--seq <id>\` or \`--all\` for others).

## Motion graphics (HTML → transparent video)
Custom animation (kinetic type, lower thirds, charts, logo reveals, particles…) is an **HTML page** in ${rel(L.motion)}/ that the
editor renders frame by frame into a transparent video clip. **Run \`vedit guide motion\` once in this chat before writing or
changing a composition** — it has the authoring rules (params, virtual time, allowed libraries) and the commands.
- **Reuse before you build.** First check \`vedit motion list\` and the files in ${rel(L.motion)}/: if the graphic (or one close to it)
  exists, change that file with small Edits. Never rewrite a whole existing composition with Write — edit the parts that change.
- **Keep the sources in the project.** The HTML, every local asset it loads, and whatever you made to produce those assets
  (scripts, cut-outs, chosen reference frames, data files) live in ${rel(L.motion)}/ — never only in a temp folder, which is
  wiped and invisible to the next chat. Only re-downloadable things (reference videos, model weights, Python environments) may stay in temp.
- Never render HTML to video or stills yourself: add it with \`vedit motion new\`, so it stays editable and re-renders on change.

## project.json essentials
- Times are **seconds**. \`start\`/\`duration\` are timeline time; \`in\` is the source in-point; \`speed\` (default 1):
  source time = in + (t − start) × speed. Clips on the same track must not overlap.
- **Everything sits on whole frames.** \`start\` and \`duration\` must be multiples of 1/fps of the sequence (at 30 fps: frame
  n starts at n/30 s — work in frames and divide, e.g. frame 371 → 12.366667). The editor moves anything else to the nearest frame
  and rewrites the file, so re-read it after saving.
- Media item: \`{ "id": "m_…", "name", "path": "media/a.mp4" or "D:/Footage/a.mp4", "type": "video|audio|image", "duration", "width", "height", "fps", "hasAudio", "folder" }\`.
  To add media you can write only \`id\` + \`path\` (or use \`vedit import\`); the editor probes the file and fills in the rest.
- Media items may also carry \`"role"\` (one of a-roll, b-roll, screen, footage, graphics, stills, voiceover, music, sfx, audio) and
  \`"tags"\` (2–5 short lowercase words about what is in it): the bin's Organise sorts by them. Set both when you add media.
- **Footage keeps its own name.** Never give a video/audio/image clip a \`name\` and never rename footage in the bin: the user
  finds clips by their file names (C0004.MP4), so the editor puts any such name back. Name sequences, folders and motion graphics freely.
- Folders (bins): \`{ "id": "f_…", "name": "A-Roll", "parent": null }\`. Media and sequences have a \`folder\` field.
- Sequence: \`{ "id", "name", "width", "height", "fps", "background", "tracks": [], "clips": [], "markers": [{ "t", "label" }] }\`.
- Tracks: \`{ "id": "v1", "kind": "video" }\` / \`{ "id": "a1", "kind": "audio" }\`, optional \`hidden\`, \`muted\`, \`locked\`, \`solo\`, \`volume\`.
  Video tracks composite in array order: **the first video track (V1) is the bottom layer**.
- Clip types:
  - \`video\`: \`{ "id", "type": "video", "track": "v1", "media": "m_…", "start", "duration", "in", "speed", "link" }\` — picture only;
    its sound is a separate \`audio\` clip sharing the same \`link\` id.
  - \`audio\`: \`{ "type": "audio", "track": "a1", "media", "start", "duration", "in", "volume": 1, "fadeIn": 0, "fadeOut": 0 }\` (volume is linear gain).
  - \`image\`: \`{ "type": "image", "media", "start", "duration" }\`
  - \`text\`: \`{ "type": "text", "text": "Line one\\nLine two", "style": { … } }\`
  - \`solid\`: \`{ "type": "solid", "color": "#ff0055" }\` — a full-frame colour matte.
  - \`sequence\` (nested sequence): \`{ "type": "sequence", "sequence": "s_…", "track": "v2", "start", "duration", "in" }\` — plays
    that sequence's picture and sound (\`in\` = where in it the clip starts); it has its own transform/effects/transitions like
    any clip. Never nest a sequence inside itself.
  - \`adjust\` (adjustment layer): \`{ "type": "adjust", "below": { "x": 0, "y": 0, "scale": 1.2, "rotation": 0 } }\` — moves,
    zooms and turns everything on the tracks under it (keyframe as \`belowX\`, \`belowY\`, \`belowScale\`, \`belowRotation\`; its
    effects apply to it too). Its own \`transform\`/\`crop\` set where that applies (full frame by default) and its opacity mixes it in.
    The way to do punch-ins and slow zooms over several clips at once.
  - Any clip: \`"enabled": false\` = disabled by the user (Shift+E): kept on the timeline but not seen, heard or exported.
- Visual clips (video/image/text/solid) can have:
  - \`transform\`: \`{ "x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1, "flipH", "flipV" }\` — x/y are pixel offsets of the
    layer centre from the frame centre (+y = down); scale 1 = native media pixels. Example: fill a 1080×1920 frame with
    1920×1080 footage → scale = max(1080/1920, 1920/1080) = 1.7778.
  - \`crop\`: \`{ "left", "top", "right", "bottom" }\` as fractions 0–1.
  - \`effects\`: \`brightness\`, \`contrast\`, \`saturation\` (−1…1, 0 = unchanged), \`hue\` (degrees), \`grayscale\` (0–1), \`blur\` (px).
  - \`lut\`: \`{ "path": "C:/…/Look.cube", "intensity": 0.8 }\` — a .cube LUT on video/image clips (path absolute or project-relative; intensity 0–1).
  - \`blend\`: normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, soft-light, hard-light, difference, add.
  - \`transitionIn\` / \`transitionOut\`: \`{ "type", "duration" }\`.
    Two-clip types — set on the **incoming** clip's \`transitionIn\`; they blend with the clip on the same track that ends exactly
    where this one starts: crossfade, dipBlack, dipWhite, wipe, push, slide.
    Single-clip animations (good for titles/captions): fade, pop, zoom, slideUp, slideDown, slideLeft, slideRight.
  - \`keyframes\`: \`{ "scale": [{ "t": 0, "v": 1, "ease": "easeInOut" }, { "t": 2, "v": 1.15 }] }\` — \`t\` = seconds from the clip's
    start. Animatable: x, y, scale, rotation, opacity, brightness, contrast, saturation, hue,
    grayscale, blur, cropLeft, cropTop, cropRight, cropBottom (crop as fractions 0–1), and volume on audio clips. \`ease\` on the earlier key: linear, easeIn,
    easeOut, easeInOut, hold. A keyframed property ignores its static transform value.
    Keys edited in the graph editor may also carry bezier handles: \`"out": { "speed": 0, "influence": 0.33 }\` (shapes the
    segment after the key) and \`"in"\` (the segment before it); speed is units/second, influence a 0–1 fraction of the
    segment. Handles override \`ease\`. Keep them when editing other fields; delete them to go back to a named ease.
- Text \`style\` (all optional): \`font\` (Google fonts like Inter, Montserrat, Poppins, Bebas Neue, Anton, Oswald; system fonts;
  or a file in fonts/), \`size\` (px), \`weight\`, \`italic\`, \`color\`, \`align\` (left/center/right), \`lineHeight\`, \`letterSpacing\`,
  \`uppercase\`, \`maxWidth\` (px, 0 = 90% of frame width), \`stroke: { color, width }\`, \`shadow: { color, opacity, blur, x, y }\`,
  \`background: { color, opacity, padding, radius, mode: "block" | "line" }\`.
- IDs must be unique: a prefix plus 8 random characters (\`c_k3j9x0aa\`, \`m_…\`, \`f_…\`, \`s_…\`). Keep the JSON valid — if it fails to
  parse, the editor keeps the last good version and shows the error to the user.

## Keep the conversation small
Every image and tool result stays in this conversation and is sent again on each later step, so a long chat costs the user
far more of their usage limit than a short one.
- **Do not launch subagents** (the Agent/Task tool) unless the user explicitly asks for one. Do the work yourself in this chat.
- Look at frames with \`vedit frame\` (already check-sized). Any image you Read that is bigger than a 540p frame (longest side
  over 960 px, or more pixels than 960×540: square frames, contact sheets) is shown to you shrunk to that size (the result
  names the shrunk copy). For fine detail (small text, edges, keying), crop the
  region at full resolution with ffmpeg and Read the crop, or name a file \`*.full.png\` to see it unshrunk — only when needed.
  Prefer one contact sheet over many separate images.
- Check the frames that can actually show a problem (the cut, the title, the changed clip), not every second of the timeline.
- Change existing files with small Edits instead of writing them out again in full: a rewritten file stays in the chat too.
- Don't print whole files or long logs when a few lines answer the question (\`vedit status\`, \`--seq\`, grep, tail).

## Working with the user
- "This clip" / "here" → read \`${ui}\` (current sequence, playhead time, selected clip ids).
- After an edit, check it visually: \`vedit frame <t>\` and Read the PNG.
- Review feedback: \`vedit comments --open\` → fix each note (comment \`t\` is seconds in that version = sequence time) →
  \`vedit reply <id> "what changed, in one short line" --resolve\` → \`vedit render\` to publish a new version.
  Exception: a **timeline round** (\`vedit comments\` says so) has no video: the user reviews the live timeline, so
  check each fix with \`vedit frame <t>\` and never render afterwards; just say when every comment is resolved.
${END}`;
}

export async function ensureClaudeMd(dir, name = 'CLAUDE.md') {
  const file = path.join(dir, name);
  const block = managedBlock(dir);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  let next;
  const s = text.indexOf(START), e = text.indexOf(END);
  if (s >= 0 && e > s) next = text.slice(0, s) + block + text.slice(e + END.length);
  else next = text ? `${text.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
  if (next !== text) await writeFileAtomic(file, next);
}

// Reference text Claude reads on demand (vedit guide <topic>) instead of carrying it in CLAUDE.md on every step.
export function guideText(topic, dir) {
  const L = layoutFor(dir);
  const rel = (p) => toPosix(path.relative(dir, p));
  if (topic === 'motion') {
    return `# Motion graphics (HTML → transparent video)
Custom animation (kinetic type, lower thirds, charts, logo reveals, particles…) is written as an **HTML page** that the
editor renders frame by frame into a transparent video clip. **Never render HTML to video yourself** — keep the
composition as a source file in the project so it can be changed and re-rendered:
- Put the page in \`${rel(L.motion)}/\` (other local assets next to it). Leave the page background transparent; size it to the
  frame with vw/vh or \`motion.width\`/\`motion.height\`. Libraries may be loaded only from cdnjs.cloudflare.com, cdn.jsdelivr.net,
  unpkg.com, esm.sh, Google Fonts — or local files; nothing else on the network is reachable.
- Declare editable values (they become Inspector fields; use them for every text/colour the user might change):
  \`<script type="application/json" id="motion">{ "duration": 5, "params": { "title": "Hello", "accent": "#ff3366" } }</script>\`
  Read them as \`motion.params.title\`; \`data-param="title"\` fills an element's text; each param is also a CSS variable \`--title\`.
- Time is virtual: CSS animations/transitions, Web Animations, GSAP, requestAnimationFrame loops, timers and
  \`Math.random\` (seeded) all render frame-exactly. For explicit control use \`motion.onSeek(t => …)\` or \`motion.timeline = gsapTimeline\`;
  \`motion.wait(promise)\` holds rendering for async loads.
- \`vedit motion new <file.html> --place --at <s> [key=value…]\` adds it (and a clip); \`vedit motion frame <id> 0.5 2 4\` renders stills —
  **Read them to check the animation**; \`vedit motion set <id> key=value\` changes params; editing the HTML re-renders automatically;
  \`vedit motion render <id>\` waits, printing progress (queue position, percent, time left) and page errors — pass what it
  prints on to the user if they ask how a render is going. In project.json a motion item is a video media item with
  \`"motion": { "src", "params", "duration", "width", "height", "fps" }\` — edit \`params\`/\`duration\` there or via \`vedit motion set\`, never its \`path\`.
  A \`"edit"\` block there holds the user's own Motion-tab changes, applied on top of the page (elements by CSS selector,
  constants by name): leave it alone, and if you restructure the page, tell the user those tweaks may need redoing.
- Change an existing composition with small Edits, never by rewriting the whole file. Keep the HTML, its local assets and the
  scripts/files used to make them in \`${rel(L.motion)}/\`${L.template ? '' : ' (subfolders are fine)'}, not in a temp folder.
- Several stills in one call (\`vedit motion frame <id> 0.5 2 4\`) cost one step instead of three.`;
  }
  return null;
}
