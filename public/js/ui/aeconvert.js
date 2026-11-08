// "Ask Claude: convert to AE project" (the timeline's clip menu on motion graphics, when After Effects is installed): one or several selected motion
// graphics rebuilt as an After Effects project, saved in the project's After Effects folder (5_Projects/3_After Effects
// in Jimmy's template). The prompt is exact on purpose: what to read, what to build, how to save it, how to check it.
import { get } from '../core/api.js';
import { notify } from '../core/notify.js';
import { app } from '../core/app.js';

// offered only when After Effects is on this computer (the server finds it: /api/state afterEffects)
export const hasAfterEffects = () => !!app.get().server?.afterEffects;

const fps = (m) => m.motion.fps || m.fps || 30;
const secs = (x) => Number(x || 0).toFixed(3).replace(/\.?0+$/, '') || '0';

// The motion-graphic clips among the selected ones (or the clicked one), in timeline order.
export function motionClips(tab, ids) {
  const seq = tab.seq;
  return seq.clips.filter((c) => ids.has(c.id) && c.media && tab.mediaById[c.media]?.motion?.src).sort((a, b) => a.start - b.start || a.track.localeCompare(b.track));
}

export function aePrompt(tab, clips, folder, app = 'After Effects') {
  const seq = tab.seq;
  const first = clips[0].start;
  const lines = clips.map((c, i) => {
    const m = tab.mediaById[c.media];
    const mo = m.motion;
    return `${i + 1}. "${c.name || m.name}" — media id ${m.id}, source ${mo.src}; ${mo.width || m.width || 1920}×${mo.height || m.height || 1080}, ${fps(m)} fps, `
      + `${secs(mo.duration || m.duration)} s long; on the timeline at ${secs(c.start - first)} s from the first selected clip (track ${c.track}), `
      + `${secs(c.duration)} s used starting ${secs(c.in || 0)} s into the graphic${c.speed && c.speed !== 1 ? ` at ${c.speed}× speed` : ''}; `
      + `params ${JSON.stringify(mo.params || {})}${mo.edit ? '; it has Motion-tab edits (the "edit" block of this media item in project.json)' : ''}.`;
  });
  const many = clips.length > 1;
  return `Convert ${many ? `these ${clips.length} motion graphics` : 'this motion graphic'} from sequence "${seq.name}" into an After Effects project. `
    + `The After Effects version must look and move exactly like what Jimmy renders: same layers, positions, sizes, fonts, colours, timings and easing.

${lines.join('\n')}

Do it in this order:
1. Read each graphic's HTML completely, with its CSS, scripts and local assets, and its media item in project.json (params, duration, size, fps, and the "edit" block: the user's Motion-tab changes, applied on top of the HTML: layer offsets / scale / rotation / opacity / anchor / masks / colours / text, retimed or re-eased GSAP calls in "anims" (key g<n> = the n+1-th gsap to/from/fromTo/set call), added layers, timing offset and speed, code values and CSS variables). Render reference stills with \`vedit motion frame <media id> <times…>\` at the start, the end and every key moment, and Read them.
2. Write one ExtendScript file, ${folder}/${many ? `${seq.name} motion graphics` : clips[0].name || tab.mediaById[clips[0].media].name}.jsx, that builds the project with app.beginUndoGroup / endUndoGroup:
   - one composition per graphic, named after it, with its exact width, height, pixel aspect 1, frame rate and duration;${many ? '\n   - a main composition (the sequence\'s size and frame rate) with each graphic\'s comp placed as a layer at its timeline offset, trimmed to the part the clip uses (in point and duration above) and time-stretched for any speed;' : ''}
   - one After Effects layer per visible element, named in whole words after its data-layer / id / text (never abbreviations), stacked in the same order (later in the page = higher), parented like the HTML nesting; group elements as precomps or nulls only where they move together;
   - text as real editable text layers: same font (PostScript name), size, weight, tracking, leading, colour, alignment, all caps, stroke / shadow; shapes and boxes as shape layers (rectangles with the same corner radius, fills, strokes, gradients); images and video imported from the project's files with their real paths (copy nothing);
   - every animation as keyframes on the matching property at the same times (GSAP tweens, CSS animations, code in motion.onSeek: work out its values per frame and key it, with a key every frame only where nothing simpler matches), easing converted to temporal ease (speed and influence) so the curves match; staggers as offset keys per layer; clip-path / masks as masks; opacity, blur, blend modes, drop shadows as the AE equivalents;
   - params that are text or colours exposed in Essential Graphics where they make sense;
   - at the end: app.project.save(new File("<absolute path of ${folder}>/<same name>.aep")).
3. Run it in After Effects (${app}): on Windows "${app}" -r "<script path>"; on a Mac osascript -e 'tell application "<that app's name>" to DoScriptFile "<script path>"'.
4. Check it without rendering: from a second short script, save single frames with comp.saveFrameToPng(time, file) at the same times as the Jimmy stills, Read them and compare side by side. Fix every difference in position, size, font, colour, timing or easing and run again until they match. Don't render the video and don't add anything to the render queue.
5. Save only in ${folder} (create it if it is missing): the .jsx, the .aep and the check frames. Don't change the HTML, its assets, project.json or the timeline: leave the .aep as it is.

When done, tell me where the .aep is, list honestly anything that could not be matched exactly (an effect with no After Effects equivalent, a missing font), and remind me that once I have rendered it from After Effects I can ask you to put the render on the timeline in place of the HTML graphic.`;
}

export async function askConvertToAE(tab, ids) {
  const clips = motionClips(tab, ids);
  if (!clips.length) return;
  let folder = '5_Projects/3_After_Effects';
  try { folder = (await get(`/api/p/${tab.projectId}/ae-folder`)).rel || folder; } catch { /* default */ }
  const { sendToClaude } = await import('./ClaudePanel.js');
  let ae = app.get().server?.afterEffects || 'After Effects';
  try { ae = (await get(`/api/p/${tab.projectId}/ae-folder`)).app || ae; } catch { /* as known */ }
  if (await sendToClaude(tab, aePrompt(tab, clips, folder, ae), tab.seq.id)) notify(`Claude is converting ${clips.length > 1 ? `${clips.length} motion graphics` : 'the motion graphic'} to an After Effects project (${folder})`, 'claude');
}
