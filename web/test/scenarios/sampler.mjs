// Scenario of the sampler (#47): 16 slots, 1 to 8 on the pads of deck A and 9 to 16 on those of deck B
// in sampler mode. A music directory in the origin private file system stands in for the one
// showDirectoryPicker would return. Checks drag and drop from the library, pad 0x30..0x37 (play from
// the start, again while playing), SHIFT + pad 0x38..0x3F (stop), the pad LED while the slot plays, an
// empty slot, the sampler volume and the outputs (MAIN, headphones with the sampler PFL), and the slots
// read back after a reload.

import { check, recordRms, sleep } from '../lib.mjs';

// Name -> [seconds, Hz]: a long sample (slot 1) and a short one (slot 9).
const FILES = { 'Long - Tone.wav': [4, 330], 'Court - Bip.wav': [0.6, 660] };
const rmsText = (rms) => rms.map((v) => v.toFixed(3)).join(' ');

export default async function ({ page, sim }) {
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const click = (sel) => page.eval(`${q(sel)}.click()`);
  const slot = (i) => `#samplerSlots [data-slot="${i}"]`;
  const slotText = (i) => page.eval(`${q(slot(i))}.textContent`);
  const pad = async (deck, number, settle = 100) => {
    const status = (0x96 + deck).toString(16);
    await sim.send(`note ${status} ${number.toString(16)} 7f`, 30);
    await sim.send(`note ${status} ${number.toString(16)} 00`, settle);
  };
  const drag = (row, i) => page.eval(`(() => {
    const dt = new DataTransfer();
    const src = document.querySelector('#library tbody tr:nth-child(${row + 1})');
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const target = document.querySelector(${JSON.stringify(slot(i))});
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(over);
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return over.defaultPrevented;
  })()`);
  const startAudio = async () => {
    await click('#start');
    await sleep(2000);
  };

  // Fresh database, directory with two WAV files written by the page, picker returning it.
  await page.eval(`new Promise((r) => { const q = indexedDB.deleteDatabase('djing'); q.onsuccess = q.onerror = q.onblocked = r; })`);
  await page.reload();
  await page.eval(`(async () => {
    const wav = (seconds, hz) => {
      const rate = 44100, frames = Math.round(rate * seconds), v = new DataView(new ArrayBuffer(44 + frames * 4));
      const text = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      text(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); text(8, 'WAVEfmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
      text(36, 'data'); v.setUint32(40, frames * 4, true);
      for (let i = 0; i < frames; i++) {
        const s = Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate));
        v.setInt16(44 + i * 4, s, true); v.setInt16(46 + i * 4, s, true);
      }
      return v.buffer;
    };
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('sampler', { recursive: true }).catch(() => {});
    const music = await root.getDirectoryHandle('sampler', { create: true });
    for (const [name, [seconds, hz]] of Object.entries(${JSON.stringify(FILES)})) {
      const w = await (await music.getFileHandle(name, { create: true })).createWritable();
      await w.write(wav(seconds, hz));
      await w.close();
    }
    window.showDirectoryPicker = () => root.getDirectoryHandle('sampler');
  })()`);
  check('16 emplacements à l\'écran, vides', await page.eval(`[...document.querySelectorAll('#samplerSlots [data-slot]')].map((b) => b.classList.contains('empty')).filter(Boolean).length`) === 16);
  check('volume du sampler à l\'écran', await page.eval(`${q('#samplerVolume')}.type === 'range'`));

  await startAudio();
  await click('#libraryPick');
  await sleep(800);
  const paths = await page.eval(`[...document.querySelectorAll('#library tbody tr')].map((tr) => tr.cells[2].textContent)`);
  check('bibliothèque listée', paths.length === 2, paths.join(', '));
  const longRow = paths.indexOf('Long - Tone.wav');
  const shortRow = paths.indexOf('Court - Bip.wav');

  // Drag and drop: the long sample on slot 1 (pad 1 of deck A), the short one on slot 9 (pad 1 of deck B).
  check('dépôt accepté sur un emplacement', await drag(longRow, 0));
  await drag(shortRow, 8);
  await sleep(800);
  check('emplacement 1 : titre glissé, chargé', /^1 · Long - Tone$/.test(await slotText(0)) && !(await page.eval(`${q(slot(0))}.classList.contains('empty')`)), await slotText(0));
  check('emplacement 9 : titre glissé, chargé', /^9 · Court - Bip$/.test(await slotText(8)), await slotText(8));

  // Sampler mode on deck A (pad mode button 0x12), crossfader in the middle.
  await sim.send('note 91 12 7f', 30);
  await sim.send('note 91 12 00', 100);
  // The burst of LEDs sent at connection can lose messages on the virtual port: "off" = not lit.
  check('LED pad 1 éteinte avant lecture', sim.lastLed(0x96, 0x30) !== 0x7f, String(sim.lastLed(0x96, 0x30)));
  let rms = await recordRms(800);
  check('silence avant lecture', rms[0] < 0.005 && rms[2] < 0.005, rmsText(rms));

  await pad(0, 0x30);
  check('pad 1 du deck A : LED allumée pendant la lecture', sim.lastLed(0x96, 0x30) === 0x7f && sim.lastLed(0x96, 0x38) === 0x7f);
  check('emplacement 1 allumé à l\'écran', await page.eval(`${q(slot(0))}.classList.contains('on')`));
  rms = await recordRms(1200);
  check('sampler sur le MAIN (canaux 1-2)', rms[0] > 0.05 && rms[1] > 0.05, rmsText(rms));
  check('casque muet sans PFL du sampler', rms[2] < 0.005 && rms[3] < 0.005, rmsText(rms));

  // 4 s sample, about 1.4 s in: relaunched at 1.6 s, it still plays at 4.6 s and stops near 5.6 s.
  await sleep(200);
  await pad(0, 0x30);
  await sleep(2700);
  check('nouvel appui pendant la lecture : relance depuis le début', sim.lastLed(0x96, 0x30) === 0x7f);
  await sleep(1500);
  check('fin de l\'échantillon : LED éteinte', sim.lastLed(0x96, 0x30) === 0x00 && sim.lastLed(0x96, 0x38) === 0x00);
  check('fin de l\'échantillon : emplacement éteint à l\'écran', !(await page.eval(`${q(slot(0))}.classList.contains('on')`)));

  // SHIFT + pad stops it.
  await pad(0, 0x30, 300);
  check('relancé après la fin', sim.lastLed(0x96, 0x30) === 0x7f);
  await pad(0, 0x38, 300);
  check('SHIFT + pad 1 : arrêt, LED éteinte', sim.lastLed(0x96, 0x30) === 0x00);
  rms = await recordRms(800);
  check('SHIFT + pad 1 : MAIN muet', rms[0] < 0.005, rmsText(rms));

  // Empty slot: nothing.
  await pad(0, 0x31, 300);
  check('emplacement vide (pad 2) : LED éteinte', sim.lastLed(0x96, 0x31) !== 0x7f, String(sim.lastLed(0x96, 0x31)));
  rms = await recordRms(800);
  check('emplacement vide : silence', rms[0] < 0.005, rmsText(rms));

  // Deck B pad 1 is slot 9: the short sample plays, then its LED goes off by itself.
  await pad(1, 0x30, 150);
  check('pad 1 du deck B : emplacement 9, LED allumée', sim.lastLed(0x97, 0x30) === 0x7f && sim.lastLed(0x96, 0x30) === 0x00);
  await sleep(900);
  check('emplacement 9 fini : LED éteinte', sim.lastLed(0x97, 0x30) === 0x00);

  // Headphones with the sampler PFL; volume on screen.
  await click('#samplerPfl');
  check('PFL du sampler allumé à l\'écran', await page.eval(`${q('#samplerPfl')}.classList.contains('on')`));
  await pad(0, 0x30);
  rms = await recordRms(1000);
  check('PFL du sampler : casque (canaux 3-4) et MAIN', rms[2] > 0.05 && rms[3] > 0.05 && rms[0] > 0.05, rmsText(rms));
  await page.eval(`(() => { const i = ${q('#samplerVolume')}; i.value = 0; i.dispatchEvent(new Event('input')); })()`);
  rms = await recordRms(800);
  check('volume du sampler à 0 : MAIN et casque muets', rms[0] < 0.005 && rms[2] < 0.005, rmsText(rms));
  await pad(0, 0x38);

  // Saved slots: back after a reload once the library is reopened.
  await page.reload();
  await sleep(500);
  check('après rechargement : emplacement 1 gardé, bibliothèque à rouvrir', /^1 · Long - Tone\.wav \(bibliothèque à ouvrir\)$/.test(await slotText(0)), await slotText(0));
  await startAudio();
  await click('#libraryReopen');
  await sleep(1200);
  check('après rechargement : emplacements 1 et 9 rechargés', /^1 · Long - Tone$/.test(await slotText(0)) && /^9 · Court - Bip$/.test(await slotText(8)),
    `${await slotText(0)} | ${await slotText(8)}`);
  check('emplacement 2 toujours vide', await page.eval(`${q(slot(1))}.classList.contains('empty')`));
  await pad(1, 0x30, 150);
  check('après rechargement : pad 1 du deck B joue l\'emplacement 9', sim.lastLed(0x97, 0x30) === 0x7f);
  await sleep(900);

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
