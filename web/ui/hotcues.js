// Hotcues: 8 cue points per deck on the performance pads (hotcue page) and on the screen. A pad sets
// its cue point when empty, else jumps to it (playing or stopped, unchanged); SHIFT + pad clears it.
// With SLIP on, a jump lasts while the pad is held: on release, playback goes back to where it would
// have been. With Q on and a beat grid, a new cue point snaps to the nearest beat. Saved per track id in the
// IndexedDB store `cues` and read back when the track is loaded from the library.
import { register, dispatch, led, refreshLeds } from '../actions.js';
import { HOTCUES } from '../mapping.js';
import { get, put } from '../library/db.js';

const empty = () => Array(HOTCUES).fill(null);
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

/** Nearest beat of `analysis` ({ bpm, firstBeat }) to `seconds`, or `seconds` without a grid. */
export function snapToBeat(seconds, analysis) {
  if (!analysis?.bpm) return seconds;
  const period = 60 / analysis.bpm;
  const beat = analysis.firstBeat + Math.round((seconds - analysis.firstBeat) / period) * period;
  return beat < 0 ? beat + period : beat; // the grid may start before 0
}

/** Adds the 8 hotcue buttons to every deck panel; ctx.hotcues[deck][n] is a position in seconds or null. */
export function createHotcues(ctx, panels) {
  ctx.hotcues = panels.map(empty);
  const deckOf = (d) => (ctx.engine?.decks[d]?.buffer ? ctx.engine.decks[d] : null);
  const buttons = panels.map(() => []);

  function show(d) {
    buttons[d].forEach((btn, n) => {
      const at = ctx.hotcues[d][n];
      btn.title = at === null ? `Hotcue ${n + 1} : poser (Maj + clic : effacer)` : `Hotcue ${n + 1} : ${fmt(at)}`;
      btn.dataset.position = at ?? '';
    });
  }

  function save(d) {
    const track = panels[d].track;
    if (!track?.id) return; // file dropped on the deck: kept until the next load only
    put('cues', { id: track.id, hotcues: ctx.hotcues[d] }).catch((err) => ctx.log(`Hotcues non sauvegardés : ${err.message}`));
  }

  for (let n = 0; n < HOTCUES; n++) {
    register(`hotcue.${n}`, (d, v) => {
      const deck = deckOf(d);
      if (!deck) return;
      if (v <= 0) return deck.releaseSlip('hotcue');
      const at = ctx.hotcues[d][n];
      // Set at the position heard (deck.position, behind the playhead by the keylock latency); jumping
      // moves the playhead, so the audio heard next starts at the cue point.
      if (at !== null) {
        deck.holdSlip('hotcue');
        return deck.seek(at);
      }
      const position = deck.quantize ? snapToBeat(deck.position, panels[d].track?.analysis) : deck.position;
      ctx.hotcues[d][n] = Math.min(Math.max(0, position), deck.duration);
      show(d);
      save(d);
    });
    register(`shift.hotcue.${n}`, (d, v) => {
      if (!deckOf(d) || v <= 0 || ctx.hotcues[d][n] === null) return;
      ctx.hotcues[d][n] = null;
      show(d);
      save(d);
    });
  }

  // A new track starts empty, then gets its saved cue points (unless another track was loaded meanwhile).
  document.addEventListener('djing:load', async ({ detail: { deck: d, track } }) => {
    ctx.hotcues[d] = empty();
    show(d);
    if (!track?.id) return;
    try {
      const saved = await get('cues', track.id);
      if (!saved || panels[d].track !== track) return;
      ctx.hotcues[d] = empty().map((_, n) => saved.hotcues[n] ?? null);
      show(d);
      refreshLeds();
    } catch (err) {
      ctx.log(`Hotcues non lus : ${err.message}`);
    }
  });

  panels.forEach((ui, d) => {
    const row = document.createElement('div');
    row.className = 'row pads hotcues';
    for (let n = 0; n < HOTCUES; n++) {
      const btn = document.createElement('button');
      btn.textContent = String(n + 1);
      btn.dataset.led = `hotcue.${n}`; // no data-act: SHIFT + click clears instead
      // Pressed and released like a pad (SLIP: the jump lasts while held); a click without a pointer
      // (keyboard, script) is a press and a release.
      const action = (e) => `${e.shiftKey ? 'shift.' : ''}hotcue.${n}`;
      let held = null;
      const release = () => {
        if (held) dispatch(held, d, 0);
        held = null;
      };
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        held = action(e);
        dispatch(held, d, 1);
      });
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.detail !== 0) return; // pointer clicks went through pointerdown / pointerup
        dispatch(action(e), d, 1);
        dispatch(action(e), d, 0);
      });
      row.append(btn);
      buttons[d].push(btn);
      led(`hotcue.${n}`, d, () => ctx.hotcues[d][n] !== null);
    }
    ui.section.append(row);
    show(d);
  });
}
