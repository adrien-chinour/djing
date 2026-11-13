// Deck panels: transport, knobs, pitch, jog, track loading and waveform. Every control goes through
// the action registry, so the controller and the screen share the same code.
import { register, dispatch, led, onLed, refreshLeds } from '../actions.js';

const $ = (sel, root) => root.querySelector(sel);
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** Builds both deck panels and registers their actions and LEDs. Returns { panels, draw(), load(deck, file) }. */
export function createDecks(ctx) {
  const panels = [...document.querySelectorAll('.deck')].map((section) => createPanel(section));
  const deckOf = (d) => ctx.engine?.decks[d];
  const onPress = (fn) => (d, v) => {
    const deck = deckOf(d);
    if (deck && v > 0) fn(deck);
  };

  register('play', onPress((deck) => deck.toggle()));
  register('cue', onPress((deck) => deck.cuePress()));
  register('pfl', onPress((deck) => deck.setPfl(!deck.pflOn)));

  const knob = (name, apply) => register(name, (d, v) => {
    const deck = deckOf(d);
    if (!deck) return;
    apply(deck, v);
    $(`[data-knob="${name}"]`, panels[d].section).value = v;
  });
  knob('volume', (deck, v) => deck.setVolume(v));
  knob('gain', (deck, v) => deck.setGain(v));
  knob('filter', (deck, v) => deck.setFilter(v));
  for (const band of ['low', 'mid', 'high']) knob(band, (deck, v) => deck.setEq(band, v));
  knob('rate', (deck, v) => deck.setRate(v));
  // The pitch fader of the controller, whose direction depends on the "pitch inversé" box.
  register('pitchFader', (d, v) => dispatch('rate', d, ctx.rateInvert ? -v : v));

  register('jog', (d, ticks) => deckOf(d)?.jog(ticks, false));
  register('jogTouched', (d, ticks) => deckOf(d)?.jog(ticks, true));
  register('shift.jog', (d, ticks) => deckOf(d)?.jog(ticks * 4, true));

  register('seek', (d, fraction) => {
    const deck = deckOf(d);
    if (deck?.buffer) deck.seek(fraction * deck.duration);
  });
  // Resolves to true once `file` plays on deck d, false when the audio is off or the file does not decode.
  async function load(d, file) {
    if (!ctx.engine) {
      ctx.log('Démarrer l\'audio avant de charger un titre');
      return false;
    }
    const ui = panels[d];
    ui.name.textContent = `chargement de ${file.name}…`;
    try {
      await ctx.engine.decks[d].load(file);
    } catch (err) {
      ui.name.textContent = `${file.name} : illisible`;
      ctx.log(`${file.name} illisible : ${err.message}`);
      refreshLeds();
      return false;
    }
    ui.name.textContent = file.name;
    ui.peaks = ctx.engine.decks[d].peaks(ui.canvas.width);
    refreshLeds();
    return true;
  }
  register('load', load);

  panels.forEach((_, d) => {
    led('play', d, () => deckOf(d)?.playing);
    led('cue', d, () => deckOf(d)?.buffer && !deckOf(d).playing);
    led('pfl', d, () => deckOf(d)?.pflOn);
  });
  // Mirrors the LEDs on the screen controls that declare data-led.
  onLed((name, d, on) => {
    if (d !== null) $(`[data-led="${name}"]`, panels[d].section)?.classList.toggle('on', on);
  });

  return { panels, load, draw: () => ctx.engine.decks.forEach((deck, d) => drawDeck(deck, panels[d])) };
}

function createPanel(section) {
  const index = Number(section.dataset.deck);
  section.append($('#deckTpl', document).content.cloneNode(true));
  $('h2', section).textContent = index === 0 ? 'Deck A' : 'Deck B';
  const ui = { section, canvas: $('canvas', section), peaks: null, name: $('.name', section), time: $('.time', section), rate: $('.rate', section) };

  $('input[type=file]', section).addEventListener('change', (e) => e.target.files[0] && dispatch('load', index, e.target.files[0]));
  section.addEventListener('dragover', (e) => { e.preventDefault(); section.classList.add('drop'); });
  section.addEventListener('dragleave', () => section.classList.remove('drop'));
  section.addEventListener('drop', (e) => {
    e.preventDefault();
    section.classList.remove('drop');
    if (e.dataTransfer.files[0]) dispatch('load', index, e.dataTransfer.files[0]);
  });
  ui.canvas.addEventListener('click', (e) => {
    const r = ui.canvas.getBoundingClientRect();
    dispatch('seek', index, (e.clientX - r.left) / r.width);
  });
  for (const input of section.querySelectorAll('[data-knob]')) {
    input.addEventListener('input', () => dispatch(input.dataset.knob, index, Number(input.value)));
  }
  // Buttons (also those added later, e.g. pad modes) dispatch their data-act on click.
  section.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) dispatch(btn.dataset.act, index, 1);
  });
  return ui;
}

function drawDeck(deck, ui) {
  const g = ui.canvas.getContext('2d');
  const { width: w, height: h } = ui.canvas;
  g.clearRect(0, 0, w, h);
  if (!ui.peaks) return;
  const accent = getComputedStyle(ui.section).getPropertyValue('--accent');
  const head = Math.floor((deck.position / deck.duration) * w);
  for (let x = 0; x < w; x++) {
    const p = ui.peaks[x] * h * 0.48;
    g.fillStyle = x < head ? '#555b66' : accent;
    g.fillRect(x, h / 2 - p, 1, p * 2);
  }
  g.fillStyle = '#fff';
  g.fillRect(head, 0, 2, h);
  g.fillStyle = '#ffcc4d';
  g.fillRect(Math.floor((deck.cuePoint / deck.duration) * w), 0, 2, h);
  ui.time.textContent = `${fmt(deck.position)} / ${fmt(deck.duration)}`;
  ui.rate.textContent = `${deck.rate >= 1 ? '+' : '−'}${(Math.abs(deck.rate - 1) * 100).toFixed(2)} %`;
}
