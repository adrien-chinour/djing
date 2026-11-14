// Scenario of the display settings (#83): "Affichage" panel of the header, presets Minimal / Mix /
// Complet, hidden blocks out of the layout, choice kept across a reload (settings store), and the
// controller still driving a hidden block.

import { check, sleep } from '../lib.mjs';

// One element per block of the panel; a block is in the layout when its element has a box.
const PROBES = {
  overview: '.deck[data-deck="0"] .overview',
  scroll: '.deck[data-deck="0"] .scroll',
  eq: '.deck[data-deck="0"] .knobs label:has([data-knob=high])',
  filter: '.deck[data-deck="0"] .knobs label:has([data-knob=filter])',
  transpose: '.deck[data-deck="0"] [data-act=keylock]',
  pads: '.deck[data-deck="0"] .pad-area',
  fx: '.deck[data-deck="0"] [data-act="padMode.fx"]',
  sampler: '#sampler',
  headphones: '.mixer label:has(#cueMix)',
  library: '#library',
  playlists: '#playlists',
  log: '#log',
};
const ALWAYS = ['.deck[data-deck="0"] .deck-head', '.deck[data-deck="0"] .transport', '#xfader', '.meters'];
const MINIMAL = ['overview', 'scroll'];
const MIX = [...MINIMAL, 'eq', 'filter', 'pads', 'library'];

export default async function ({ page, sim }) {
  const laidOut = () => page.eval(`Object.fromEntries(Object.entries(${JSON.stringify(PROBES)})
    .map(([id, sel]) => [id, document.querySelector(sel).getClientRects().length > 0]))`);
  const alwaysShown = () => page.eval(`${JSON.stringify(ALWAYS)}.every((sel) => document.querySelector(sel).getClientRects().length > 0)`);
  const shownOf = (state) => Object.keys(state).filter((id) => state[id]).sort().join();
  const scrollHeight = () => page.eval(`document.querySelector('.deck[data-deck="0"] .scroll').getBoundingClientRect().height`);
  const saved = () => page.eval(`new Promise((resolve, reject) => {
    const open = indexedDB.open('djing');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const q = open.result.transaction('settings').objectStore('settings').get('display');
      q.onsuccess = () => { open.result.close(); resolve(q.result ?? null); }; };
  })`);
  const preset = async (name) => { await page.eval(`document.querySelector('.display [data-preset=${name}]').click()`); await sleep(200); };
  const presetOn = () => page.eval(`[...document.querySelectorAll('.display [data-preset]')].filter((b) => b.classList.contains('on')).map((b) => b.dataset.preset).join()`);

  // A laptop screen, so the room left by hidden blocks is measurable (cleared at the end).
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  // Start from no saved choice: the default preset is Mix.
  await page.eval(`new Promise((resolve) => { const open = indexedDB.open('djing');
    open.onsuccess = () => { const tx = open.result.transaction('settings', 'readwrite'); tx.objectStore('settings').delete('display');
      tx.oncomplete = () => { open.result.close(); resolve(); }; }; })`);
  await page.reload();
  await sleep(300);
  check('sans choix enregistré : préréglage Mix', shownOf(await laidOut()) === [...MIX].sort().join() && (await presetOn()) === 'mix', shownOf(await laidOut()));

  // The panel: a details of the header, one checkbox per block, no native dialog.
  await page.eval(`window.confirm = window.alert = window.prompt = () => { window.nativeDialogs = (window.nativeDialogs || 0) + 1; return true; }`);
  await page.eval(`document.querySelector('.topbar .display summary').click()`);
  const panel = await page.eval(`(() => { const d = document.querySelector('.topbar .display');
    return { open: d.open, visible: d.querySelector('.popover').getClientRects().length > 0,
      boxes: [...d.querySelectorAll('.blocks input[type=checkbox]')].map((b) => b.dataset.block) }; })()`);
  check('bouton « Affichage » de l\'en-tête : panneau ouvert dans la page', panel.open && panel.visible);
  check('panneau : une case par bloc masquable', panel.boxes.sort().join() === Object.keys(PROBES).sort().join(), panel.boxes.join());

  const mixHeight = await scrollHeight();
  await preset('minimal');
  let state = await laidOut();
  check('préréglage Minimal : seules les waveforms restent parmi les blocs masquables', shownOf(state) === [...MINIMAL].sort().join(), shownOf(state));
  check('préréglage Minimal : en-tête des decks, transport, crossfader et VU restent', await alwaysShown());
  const minimalHeight = await scrollHeight();
  check('préréglage Minimal : l\'espace libéré va à la waveform défilante', minimalHeight > mixHeight + 100, `${mixHeight} -> ${minimalHeight} px`);
  check('préréglage Minimal enregistré dans le magasin settings', JSON.stringify(await saved()) === JSON.stringify(MINIMAL), JSON.stringify(await saved()));
  check('aucune fenêtre native', !(await page.eval('window.nativeDialogs')));

  // Kept across a reload.
  await page.reload();
  await sleep(300);
  state = await laidOut();
  check('rechargement : choix Minimal conservé', shownOf(state) === [...MINIMAL].sort().join() && (await presetOn()) === 'minimal', shownOf(state));
  check('rechargement : cases à jour', await page.eval(`[...document.querySelectorAll('.display .blocks input')].filter((b) => b.checked).map((b) => b.dataset.block).sort().join()`) === [...MINIMAL].sort().join());

  // The controller still drives a hidden block: FX button of deck A (slot 3), EQ knob, FX pad page.
  await page.eval(`document.querySelector('#start').click()`);
  await sleep(2000);
  await sim.send('note 91 00 7f', 50);
  await sim.send('note 91 00 00');
  check('effets masqués : le bouton FX de la platine active l\'emplacement 3', await page.eval(`window.djing.engine.decks[0].fx.slots[2].on`));
  check('effets masqués : LED du bouton FX allumée', sim.lastLed(0x91, 0x00) === 0x7f);
  await sim.send('cc b1 04 00');
  check('EQ masqué : le potentiomètre High de la platine agit sur le curseur', Number(await page.eval(`document.querySelector('.deck[data-deck="0"] [data-knob=high]').value`)) === 0);

  // One checkbox: a single block back, no preset matches.
  await page.eval(`(() => { const b = document.querySelector('.display [data-block=log]'); b.click(); })()`);
  await sleep(200);
  state = await laidOut();
  check('case « Journal MIDI » cochée : journal revenu, aucun préréglage allumé', state.log && !state.library && (await presetOn()) === '');
  await preset('complet');
  check('préréglage Complet : tous les blocs', Object.values(await laidOut()).every(Boolean));

  // Leave the default for the next scenarios.
  await page.eval(`new Promise((resolve) => { const open = indexedDB.open('djing');
    open.onsuccess = () => { const tx = open.result.transaction('settings', 'readwrite'); tx.objectStore('settings').delete('display');
      tx.oncomplete = () => { open.result.close(); resolve(); }; }; })`);
  await page.send('Emulation.clearDeviceMetricsOverride');
  check('aucune exception dans la page', page.errors.length === 0, page.errors.join(' | '));
}
