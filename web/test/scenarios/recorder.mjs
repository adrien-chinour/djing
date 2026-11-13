// Scenario of the mix recording (#50): REC records the MAIN to WebM Opus at 256 kb/s, the clock runs,
// a second press stops and downloads `mix-YYYY-MM-DD-HHMM.webm`; the recording survives a tab
// change and 5 s recorded decode to 5 s ±0.3 s of sound.

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

export default async function ({ page, sim }) {
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  const downloads = join(tmp, 'downloads-50');
  mkdirSync(downloads, { recursive: true });
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;

  // Records the options given to MediaRecorder, to check format and bitrate.
  await page.eval(`(() => {
    const Native = window.MediaRecorder;
    window.MediaRecorder = class extends Native {
      constructor(stream, options) { super(stream, options); window.recorderOptions = { ...options, mimeType: this.mimeType, bitrate: this.audioBitsPerSecond }; }
    };
  })()`);

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  await sim.send('xfader 0');
  await sim.send('press A play', 500);

  const startedAt = new Date();
  await page.eval(`${q('#rec')}.click()`);
  const t0 = Date.now();
  check('REC passe en enregistrement', await page.eval(`${q('#rec')}.classList.contains('rec')`));
  const opts = await page.eval('window.recorderOptions');
  check('format WebM Opus', /^audio\/webm;\s*codecs=opus$/i.test(opts?.mimeType ?? ''), opts?.mimeType);
  check('débit demandé 256 kb/s', opts?.audioBitsPerSecond === 256000 && opts?.bitrate === 256000, `${opts?.audioBitsPerSecond} ${opts?.bitrate}`);

  // Tab change: a second tab comes to the front, the page is hidden for ~2 s, then comes back.
  await sleep(1000);
  const { targetId } = await page.send('Target.createTarget', { url: 'about:blank' });
  await page.send('Target.activateTarget', { targetId });
  await sleep(2000);
  const hidden = await page.eval('document.visibilityState');
  await page.send('Target.closeTarget', { targetId });
  check('toujours en enregistrement après un changement d\'onglet', await page.eval(`${q('#rec')}.classList.contains('rec')`), `visibilité pendant l'autre onglet : ${hidden}`);

  await sleep(5000 - (Date.now() - t0) - 300);
  const clock = await page.eval(`${q('#recTime')}.textContent`);
  check('chronomètre à 0:04', clock === '0:04', clock);
  await sleep(5000 - (Date.now() - t0));
  await page.eval(`${q('#rec')}.click()`);
  check('second appui : arrêt', !(await page.eval(`${q('#rec')}.classList.contains('rec')`)));

  let files = [];
  for (let i = 0; i < 50 && !files.some((f) => f.endsWith('.webm')); i++) {
    await sleep(200);
    files = readdirSync(downloads);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const expected = `mix-${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}-${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}.webm`;
  check('fichier téléchargé au nom de l\'heure de début', files.includes(expected), `${files.join(', ')} ; attendu ${expected}`);
  const link = await page.eval(`${q('#recFile')}.hidden ? '' : ${q('#recFile')}.download`);
  check('lien de téléchargement laissé à l\'écran', link === expected, link);
  if (!files.includes(expected)) return;

  const b64 = readFileSync(join(downloads, expected)).toString('base64');
  const decoded = await page.eval(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const buf = await window.djing.engine.ctx.decodeAudioData(bytes.buffer);
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return { duration: buf.duration, channels: buf.numberOfChannels, rms: Math.sqrt(sum / data.length) };
  })()`);
  check('5 s enregistrées : fichier décodable de 5 s ±0,3 s', Math.abs(decoded.duration - 5) <= 0.3, `${decoded.duration.toFixed(3)} s`);
  check('le fichier contient le MAIN (stéréo, non muet)', decoded.channels === 2 && decoded.rms > 0.05, `${decoded.channels} canaux, RMS ${decoded.rms.toFixed(3)}`);
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
