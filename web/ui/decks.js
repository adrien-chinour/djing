// Deck panels: transport, knobs, pitch, jog and track loading (waveforms: waveform.js). Every control goes through
// the action registry, so the controller and the screen share the same code.
import { register, dispatch, led, onLed, refreshLeds } from '../actions.js';
import { patch } from '../library/db.js';
import { analyzeFile, announce, formatBpm, formatKey } from '../analysis/queue.js';

const AUTO_LOOPS = [0.5, 1, 2, 4, 8, 16]; // beats, buttons of index.html

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
  knob('transpose', (deck, v) => deck.setTranspose(v));
  register('keylock', onPress((deck) => deck.setKeylock(!deck.keylock)));
  // The pitch fader of the controller, whose direction depends on the "pitch inversé" box.
  register('pitchFader', (d, v) => dispatch('rate', d, ctx.rateInvert ? -v : v));

  register('vinyl', onPress((deck) => deck.setVinyl(!deck.vinyl)));
  register('quantize', onPress((deck) => { deck.quantize = !deck.quantize; }));

  // Sync (sync.js): SYNC on the follower, SHIFT + SYNC chooses the master, SHIFT + Q the pitch range.
  register('sync', (d, v) => {
    if (!deckOf(d) || v <= 0) return;
    const error = ctx.engine.sync.toggle(d);
    panels[d].syncError = error && { text: error, until: performance.now() + 4000 };
    if (error) ctx.log(error);
  });
  register('shift.sync', (d, v) => v > 0 && ctx.engine?.sync.toggleLeader(d));
  register('shift.quantize', onPress((deck) => deck.cycleRateRange()));
  register('slip', onPress((deck) => deck.setSlip(!deck.slip)));
  register('wheelTouch', (d, v) => deckOf(d)?.touch(v > 0));
  register('shift.wheelTouch', (d, v) => deckOf(d)?.touch(v > 0));
  register('jog', (d, ticks) => deckOf(d)?.jog(ticks, false));
  register('jogTouched', (d, ticks) => deckOf(d)?.touchedJog(ticks));
  register('shift.jog', (d, ticks) => deckOf(d)?.seekJog(ticks));

  // Loops: LOOP IN / LOOP OUT, SHIFT + LOOP IN / OUT halve / double, auto loops of n beats (Q: from the current beat).
  register('loopIn', onPress((deck) => deck.loopIn()));
  register('loopOut', onPress((deck) => deck.loopOut()));
  register('shift.loopIn', onPress((deck) => deck.scaleLoop(0.5)));
  register('shift.loopOut', onPress((deck) => deck.scaleLoop(2)));
  // Auto loop buttons toggle (Mixxx beatloop_X_toggle); SORTIR leaves the active loop (Mixxx reloop_toggle).
  for (const beats of AUTO_LOOPS) register(`autoLoop.${beats}`, onPress((deck) => deck.toggleAutoLoop(beats)));
  register('reloop', onPress((deck) => deck.exitLoop()));

  register('seek', (d, fraction) => {
    const deck = deckOf(d);
    if (deck?.buffer) deck.seek(fraction * deck.duration);
  });
  // Resolves to true once `file` plays on deck d, false when the audio is off or the file does not decode.
  // Announces the new track with a `djing:load` event ({ deck, track }).
  // `track` is the library entry of the file (id, analysis), absent for a file dropped or picked on the deck:
  // such a file is analysed in the background (not saved) and gets its grid and BPM through "djing:analysis".
  async function load(d, file, track = null) {
    if (!ctx.engine) {
      ctx.log('Démarrer l\'audio avant de charger un titre');
      return false;
    }
    const ui = panels[d];
    ui.name.textContent = `chargement de ${file.name}…`;
    ui.track = null;
    showBpm(ui);
    try {
      await ctx.engine.decks[d].load(file);
    } catch (err) {
      ui.name.textContent = `${file.name} : illisible`;
      ctx.log(`${file.name} illisible : ${err.message}`);
      refreshLeds();
      return false;
    }
    ui.name.textContent = file.name;
    ui.track = track ?? { file };
    setGrid(d);
    showBpm(ui);
    ctx.engine.decks[d].setBpm(track?.analysis?.bpm ?? null, track?.analysis?.firstBeat); // effects and sync
    document.dispatchEvent(new CustomEvent('djing:load', { detail: { deck: d, track } }));
    refreshLeds();
    if (!track) analyzeFile(ui.track).catch((err) => ctx.log(`${file.name} : analyse impossible (${err.message})`));
    return true;
  }
  register('load', load);

  // Beat grid of the loaded track: ×2, ÷2 and ±10 ms, saved with the track.
  const editGrid = (name, edit) => register(name, (d, v) => {
    const track = panels[d].track;
    if (v <= 0 || !track?.analysis?.bpm) return;
    track.analysis = edit(track.analysis);
    if (track.id) patch('tracks', track.id, { analysis: track.analysis }).catch((err) => ctx.log(`Grille non sauvegardée : ${err.message}`));
    announce(track);
  });
  editGrid('grid.double', (a) => ({ ...a, bpm: a.bpm * 2 }));
  editGrid('grid.half', (a) => ({ ...a, bpm: a.bpm / 2 }));
  editGrid('grid.earlier', (a) => ({ ...a, firstBeat: a.firstBeat - 0.01 }));
  editGrid('grid.later', (a) => ({ ...a, firstBeat: a.firstBeat + 0.01 }));
  document.addEventListener('djing:analysis', ({ detail: track }) => {
    panels.forEach((ui, d) => {
      if (ui.track !== track) return;
      setGrid(d);
      showBpm(ui);
      deckOf(d)?.setBpm(track.analysis?.bpm ?? null, track.analysis?.firstBeat);
    });
  });
  /** Beat grid of deck d (auto loops, loop lengths in beats), from the analysis of its track. */
  function setGrid(d) {
    const analysis = panels[d].track?.analysis;
    if (deckOf(d)) deckOf(d).grid = analysis?.bpm ? { bpm: analysis.bpm, firstBeat: analysis.firstBeat } : null;
  }

  panels.forEach((_, d) => {
    led('play', d, () => deckOf(d)?.playing);
    led('cue', d, () => deckOf(d)?.buffer && !deckOf(d).playing);
    led('pfl', d, () => deckOf(d)?.pflOn);
    led('vinyl', d, () => deckOf(d)?.vinyl);
    led('keylock', d, () => deckOf(d)?.keylocked); // forced by toneplay too
    led('quantize', d, () => deckOf(d)?.quantize);
    led('slip', d, () => deckOf(d)?.slip);
    led('loopIn', d, () => !!deckOf(d)?.loop);
    led('sync', d, () => ctx.engine?.sync.follower === d);
  });
  // Mirrors the LEDs on the screen controls that declare data-led.
  onLed((name, d, on) => {
    if (d !== null) $(`[data-led="${name}"]`, panels[d].section)?.classList.toggle('on', on);
  });

  return {
    panels,
    load,
    draw: () => {
      refreshLeds(); // the sync can end without an action (fader taken over, track loaded)
      ctx.engine.decks.forEach((deck, d) => drawDeck(deck, panels[d], ctx.engine.sync));
    },
  };
}

function createPanel(section) {
  const index = Number(section.dataset.deck);
  section.append($('#deckTpl', document).content.cloneNode(true));
  $('h2', section).textContent = index === 0 ? 'Deck A' : 'Deck B';
  const ui = { section, name: $('.name', section), time: $('.time', section), remain: $('.remain', section), rate: $('.rate', section), bpm: $('.bpm', section), key: $('.key', section), track: null, transpose: $('.transpose', section), latency: $('.latency', section), master: $('.master', section), range: $('.range', section), reloop: $('[data-act="reloop"]', section), syncError: null };

  $('input[type=file]', section).addEventListener('change', (e) => e.target.files[0] && dispatch('load', index, e.target.files[0]));
  section.addEventListener('dragover', (e) => { e.preventDefault(); section.classList.add('drop'); });
  section.addEventListener('dragleave', () => section.classList.remove('drop'));
  section.addEventListener('drop', (e) => {
    e.preventDefault();
    section.classList.remove('drop');
    if (e.dataTransfer.files[0]) dispatch('load', index, e.dataTransfer.files[0]);
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

function showBpm(ui) {
  const analysis = ui.track?.analysis;
  if (analysis?.bpm) setBpm(ui.bpm, formatBpm(analysis), analysis.firstBeat);
  else ui.bpm.textContent = ui.track ? formatBpm(analysis) : 'BPM —';
  ui.key.textContent = ui.track ? formatKey(analysis) : '—';
}

/** Tempo in large figures, then the unit and the first beat in small type ("124.00 BPM · 1er temps 0.120 s"). */
function setBpm(el, figure, firstBeat) {
  const beat = ` · 1er temps ${firstBeat.toFixed(3)} s`;
  if (el.textContent === `${figure} BPM${beat}`) return;
  const tag = (name, text, className = '') => Object.assign(document.createElement(name), { textContent: text, className });
  el.replaceChildren(tag('b', figure), tag('small', ' BPM'), tag('small', beat, 'beat'));
}

function drawDeck(deck, ui, sync) {
  ui.time.textContent = `${fmt(deck.position)} / ${fmt(deck.duration)}`;
  ui.remain.textContent = `−${fmt(Math.max(0, deck.duration - deck.position))}`;
  ui.rate.textContent = `${deck.rate >= 1 ? '+' : '−'}${(Math.abs(deck.rate - 1) * 100).toFixed(2)} %`;
  ui.transpose.textContent = `${deck.transpose > 0 ? '+' : deck.transpose < 0 ? '−' : '±'}${Math.abs(deck.transpose)} dt`;
  ui.latency.textContent = `latence ${Math.round(deck.delay * 1000)} ms`;
  ui.range.textContent = `±${Math.round(deck.rateRange * 100)} %`;
  ui.reloop.disabled = !deck.loop;
  // Tempo heard: analysed BPM × pitch.
  if (deck.bpm) setBpm(ui.bpm, (deck.bpm * deck.rate).toFixed(2), deck.firstBeat);
  if (ui.syncError && performance.now() > ui.syncError.until) ui.syncError = null;
  ui.master.textContent = ui.syncError?.text
    ?? (sync.shownMaster === deck.index ? 'MAÎTRE' : sync.follower === deck.index ? `SYNC → ${'AB'[sync.master]}` : '');
}
