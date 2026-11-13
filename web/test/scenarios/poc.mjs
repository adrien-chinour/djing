// Scenario of the web/ proof of concept: the simulated controller is bound, MAIN and headphones go
// to two separate outputs, and PLAY, PFL, volume fader, crossfader, pitch fader and jog act on deck A.

import { join } from 'node:path';
import { check, recordRms, sleep, tmp, writeTone } from '../lib.mjs';

export default async function ({ page, sim }) {
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const deckA = (sel) => q(`.deck[data-deck="0"] ${sel}`);

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  check('le simulateur est vu comme la platine', (await page.eval(`${q('#midi')}.textContent`)).includes('connectée'));
  const out = await page.eval(`${q('#out')}.textContent`);
  check('mode deux sorties stéréo', out.startsWith('split'), out);
  check('MAIN sur « Inpulse MAIN »', /Inpulse MAIN/.test(await page.eval(`${q('#mainDevice')}.selectedOptions[0].text`)));
  check('casque sur « Inpulse Casque »', /Inpulse Casque/.test(await page.eval(`${q('#cueDevice')}.selectedOptions[0].text`)));

  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  check('titre chargé sur le deck A', (await page.eval(`${deckA('.name')}.textContent`)) === 'tone.wav');
  check('LED CUE allumée quand un titre est chargé', sim.lastLed(0x91, 0x06) === 0x7f);

  await sim.send('xfader 0');
  await sim.send('press A play', 500);
  check('PLAY de la platine lance le deck A', await page.eval(`${deckA('[data-act=play]')}.classList.contains('on')`));
  check('LED PLAY allumée', sim.lastLed(0x91, 0x07) === 0x7f);
  let rms = await recordRms(1200);
  check('MAIN (canaux 1-2) reçoit le deck A', rms[0] > 0.05 && rms[1] > 0.05, rms.map((v) => v.toFixed(3)).join(' '));
  check('casque (canaux 3-4) muet sans PFL', rms[2] < 0.005 && rms[3] < 0.005);

  await sim.send('press A pfl');
  check('LED PFL allumée', sim.lastLed(0x91, 0x0c) === 0x7f);
  rms = await recordRms(1200);
  check('casque (canaux 3-4) reçoit le deck A avec PFL', rms[2] > 0.05 && rms[3] > 0.05, rms.map((v) => v.toFixed(3)).join(' '));

  await sim.send('knob A volume 0');
  rms = await recordRms(1200);
  check('fader à 0 : MAIN muet', rms[0] < 0.005, rms.map((v) => v.toFixed(3)).join(' '));
  check('fader à 0 : casque toujours actif (pré-fader)', rms[2] > 0.05);
  check('le fader de la platine bouge celui de l\'écran', (await page.eval(`${deckA('[data-knob=volume]')}.value`)) === '0');

  await sim.send('knob A volume 1');
  await sim.send('xfader 1');
  rms = await recordRms(1200);
  check('crossfader à droite : deck A coupé du MAIN', rms[0] < 0.005, rms.map((v) => v.toFixed(3)).join(' '));

  await sim.send('rate A 1');
  const rateText = await page.eval(`${deckA('.rate')}.textContent`);
  check('pitch fader en butée : ±8 %', /8\.00 %/.test(rateText), rateText);
  await sim.send('rate A 0');

  await sim.send('press A play', 300);
  check('PLAY arrête le deck A', !(await page.eval(`${deckA('[data-act=play]')}.classList.contains('on')`)));
  check('LED PLAY éteinte', sim.lastLed(0x91, 0x07) === 0x00);
  const before = await page.eval(`${deckA('.time')}.textContent`);
  await sim.send('jog A 50 touched', 300);
  const after = await page.eval(`${deckA('.time')}.textContent`);
  check('jog touché à l\'arrêt : avance d\'une seconde', before !== after, `${before} -> ${after}`);

  if (process.env.DEBUG) console.log(await page.eval(`${q('#log')}.textContent`), await page.eval(`navigator.requestMIDIAccess().then(a => [...a.inputs.values(), ...a.outputs.values()].map(p => p.type + ':' + p.name))`));
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
