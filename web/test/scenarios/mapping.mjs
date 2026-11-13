// Scenario of the declarative mapping (#30): pad mode buttons switch the pad page of a deck and its
// LED, from the controller and from the screen; SHIFT messages reach their own actions.

import { join } from 'node:path';
import { check, sleep, tmp, writeTone } from '../lib.mjs';

export default async function ({ page, sim }) {
  const wav = join(tmp, 'tone.wav');
  writeTone(wav);
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const deck = (d, sel) => q(`.deck[data-deck="${d}"] ${sel}`);
  const isOn = (d, sel) => page.eval(`${deck(d, sel)}.classList.contains('on')`);

  await page.eval(`${q('#start')}.click()`);
  await sleep(2000);
  check('mode de pads par défaut : LED hotcue allumée sur les deux decks', sim.lastLed(0x91, 0x0f) === 0x7f && sim.lastLed(0x92, 0x0f) === 0x7f);
  check('mode hotcue affiché à l\'écran', await isOn(0, '[data-led="padMode.hotcue"]'));

  await sim.send('note 91 10 7f');
  await sim.send('note 91 10 00');
  check('bouton de mode roll du deck A : LED roll allumée, LED hotcue éteinte', sim.lastLed(0x91, 0x10) === 0x7f && sim.lastLed(0x91, 0x0f) === 0x00);
  check('mode roll affiché à l\'écran du deck A', await isOn(0, '[data-led="padMode.roll"]') && !(await isOn(0, '[data-led="padMode.hotcue"]')));
  check('le deck B garde son mode', sim.lastLed(0x92, 0x0f) === 0x7f && sim.lastLed(0x92, 0x10) !== 0x7f);

  await page.eval(`${deck(1, '[data-act="padMode.fx"]')}.click()`);
  await sleep(150);
  check('bouton FX à l\'écran du deck B : LED FX de la platine allumée', sim.lastLed(0x92, 0x14) === 0x7f && sim.lastLed(0x92, 0x0f) === 0x00);

  const doc = await page.send('DOM.getDocument');
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.deck[data-deck="0"] input[type=file]' });
  await page.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wav] });
  await sleep(1000);
  await sim.send('note 94 07 7f');
  await sim.send('note 94 07 00');
  await sim.send('note 93 00 7f');
  await sim.send('note 93 00 00');
  const log = await page.eval(`${q('#log')}.textContent`);
  check('SHIFT routé vers ses propres actions', /94 07 7f → shift\.play/.test(log) && /93 00 7f → shift\.browser/.test(log));
  check('SHIFT + PLAY ne lance pas le deck A', !(await isOn(0, '[data-act=play]')));

  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
