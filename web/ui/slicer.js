// Slicer and slicer loop pad modes, as DJCi300.deck[n].slicerPad in the Hercules script shipped with
// Mixxx (/usr/share/mixxx/controllers/Hercules-DJControl-Inpulse-300-script.js):
// - pressing SLICER or SLICER LOOP turns the slicer on, or off when it is already on: a window of 8 beats
//   from the beat nearest to the position heard, cut in 8 slices of one beat; any other mode turns it off;
// - slicer: the loop is off; slicer loop: the window is the active loop;
// - pads held: loop from the first to the last held slice, playback jumps to its start; all released:
//   back to the window (loop off in slicer mode, window looped in slicer loop mode);
// - the LED of the current slice follows playback (held pads light from the first to the last); in
//   slicer mode the window moves 8 beats forward once playback leaves it;
// - loading a track, or a loop set by another control (LOOP IN / OUT, auto loops), turns it off;
// - without a beat grid, nothing turns on and the deck says so.
import { register, dispatch, led, refreshLeds } from '../actions.js';
import { padPages } from './pads.js';
import { SLICES } from '../mapping.js';
import { snapToBeat } from './hotcues.js';

const MODES = ['slicer', 'slicerloop'];
const TICK_MS = 20;
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** Adds the slicer pads and status to every deck panel; ctx.slicer[deck] holds its state. */
export function createSlicer(ctx, panels) {
  // slices: [{ start, end }] (s) while on, else null; beat: current slice (0..8, -1 off); own: loop set here.
  ctx.slicer = panels.map(() => ({ slices: null, pressed: Array(SLICES).fill(false), beat: -1, own: null }));
  const deckOf = (d) => (ctx.engine?.decks[d]?.buffer ? ctx.engine.decks[d] : null);
  const looping = (d) => ctx.padMode[d] === 'slicerloop';

  function setLoop(d, deck, loop) {
    deck.setLoop(loop);
    ctx.slicer[d].own = loop;
  }

  /** Window of 8 slices from `start`; the loop goes off (slicer) or onto the window (slicer loop). */
  function connect(d, start) {
    const deck = deckOf(d);
    const beat = deck?.beatLength;
    const s = ctx.slicer[d];
    if (!beat) return;
    s.slices = Array.from({ length: SLICES }, (_, n) => ({ start: start + n * beat, end: start + (n + 1) * beat }));
    const window = { start, end: s.slices[SLICES - 1].end };
    if (looping(d)) setLoop(d, deck, window);
    else if (deck.loop) setLoop(d, deck, null);
    else s.own = null;
    s.beat = currentSlice(d, deck);
  }

  /** Turns the slicer off; its own loop goes with it (Mixxx clears loop_start_position). */
  function disconnect(d, { keepLoop = false } = {}) {
    const s = ctx.slicer[d];
    if (!s.slices) return;
    const deck = ctx.engine?.decks[d];
    if (!keepLoop && deck?.loop && deck.loop === s.own) deck.setLoop(null);
    s.slices = null;
    s.beat = -1;
    s.own = null;
  }

  /** Number of slices already played (8 once playback has left the window). */
  function currentSlice(d, deck) {
    const position = deck.position;
    return ctx.slicer[d].slices.filter((slice) => position >= slice.end).length;
  }

  /** First and last held pads, -1 when none is held. */
  const held = (s) => [s.pressed.indexOf(true), s.pressed.lastIndexOf(true)];

  /** Pad n of the slicer page of deck d is lit (the mode itself is checked by the caller). */
  function lit(d, n) {
    const s = ctx.slicer[d];
    if (!s.slices) return false;
    const [first, last] = held(s);
    return first !== -1 ? n >= first && n <= last : n === Math.min(s.beat, SLICES - 1);
  }

  document.addEventListener('djing:padMode', ({ detail: { deck: d, mode, old } }) => {
    if (MODES.includes(mode)) {
      if (ctx.slicer[d].slices) return disconnect(d);
      const deck = deckOf(d);
      if (!deck) return;
      if (!deck.grid) return ctx.log(`Deck ${'AB'[d]} : slicer inactif, pas de grille`);
      connect(d, snapToBeat(deck.position, deck.grid));
    } else if (MODES.includes(old)) {
      disconnect(d);
    }
  });
  document.addEventListener('djing:load', ({ detail: { deck: d } }) => disconnect(d, { keepLoop: true }));

  for (let n = 0; n < SLICES; n++) {
    register(`slicer.${n}`, (d, v) => {
      const s = ctx.slicer[d];
      s.pressed[n] = v > 0;
      const deck = deckOf(d);
      if (!s.slices || !deck) return;
      const [first, last] = held(s);
      if (first !== -1) {
        const loop = { start: s.slices[first].start, end: s.slices[last].end };
        setLoop(d, deck, loop);
        deck.seek(loop.start);
      } else {
        setLoop(d, deck, looping(d) ? { start: s.slices[0].start, end: s.slices[SLICES - 1].end } : null);
      }
    });
    for (const mode of MODES) panels.forEach((_, d) => led(`${mode}.${n}`, d, () => ctx.padMode[d] === mode && lit(d, n)));
  }

  // Follows playback: current slice, window moved forward in slicer mode, slicer off when another
  // control changed the loop.
  function tick() {
    ctx.slicer.forEach((s, d) => {
      const deck = deckOf(d);
      if (s.slices && (!deck || deck.loop !== s.own)) disconnect(d, { keepLoop: true });
      if (s.slices) {
        s.beat = currentSlice(d, deck);
        if (ctx.padMode[d] === 'slicer' && s.beat >= SLICES) connect(d, s.slices[SLICES - 1].end);
      }
      show(d);
    });
    refreshLeds();
  }
  setInterval(tick, TICK_MS);

  const views = panels.map((ui, d) => {
    const row = document.createElement('div');
    row.className = 'row pads slicer';
    const label = document.createElement('span');
    label.className = 'slicer-status';
    const buttons = [];
    for (let n = 0; n < SLICES; n++) {
      const btn = document.createElement('button');
      btn.textContent = `S${n + 1}`;
      btn.title = `Tranche ${n + 1} (tenir)`;
      // Held like a pad: down on press, up on release (no data-act, the click would only press it).
      btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); dispatch(`slicer.${n}`, d, 1); });
      const release = () => ctx.slicer[d].pressed[n] && dispatch(`slicer.${n}`, d, 0);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointerleave', release);
      row.append(btn);
      buttons.push(btn);
    }
    row.append(label);
    padPages(ui).append(row);
    return { label, buttons };
  });

  /** Screen side: pads lit as on the controller, and the state of the slicer under them. */
  function show(d) {
    const { label, buttons } = views[d];
    const mode = ctx.padMode[d];
    const on = MODES.includes(mode);
    buttons.forEach((btn, n) => btn.classList.toggle('on', on && lit(d, n)));
    const s = ctx.slicer[d];
    const deck = deckOf(d);
    const text = !on ? ''
      : deck && !deck.grid ? 'Slicer inactif : pas de grille'
        : s.slices ? `Slicer : ${fmt(s.slices[0].start)} → ${fmt(s.slices[SLICES - 1].end)}`
          : 'Slicer arrêté (appuyer sur le mode pour l\'activer)';
    if (label.textContent !== text) label.textContent = text;
  }
}
