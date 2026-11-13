// Toneplay pad page, as DJCi300.toneplay of the Hercules script shipped with Mixxx: a pad jumps to
// hotcue 1 (set first at the position heard when the deck has none) and transposes by +0, +1, +2, +3,
// -4, -3, -2, -1 semitones; SHIFT + pad only transposes. Keylock is forced while that transposition
// holds (engine.js, setTranspose). LEDs: the pad of the current transposition, clamped to -4..+3 and
// rounded, whatever set it. Also on screen: eight buttons, Maj + click only transposes.
import { register, dispatch, led } from '../actions.js';
import { TONEPLAY_SEMITONES } from '../mapping.js';

const label = (s) => `${s < 0 ? '−' : '+'}${Math.abs(s)}`;

/** Pad lit for a transposition: the clamped, rounded semitone, as DJCi300.updateToneplayLED. */
const padOf = (transpose) => {
  const s = Math.round(Math.max(-4, Math.min(3, transpose)));
  return TONEPLAY_SEMITONES.indexOf(s);
};

/** Adds the toneplay row to every deck panel. */
export function createToneplay(ctx, panels) {
  const deckOf = (d) => (ctx.engine?.decks[d]?.buffer ? ctx.engine.decks[d] : null);

  function transpose(d, deck, semitones) {
    deck.setTranspose(semitones, { toneplay: true });
    const knob = panels[d].section.querySelector('[data-knob="transpose"]');
    if (knob) knob.value = deck.transpose;
  }

  TONEPLAY_SEMITONES.forEach((semitones, n) => {
    register(`toneplay.${n}`, (d, v) => {
      const deck = deckOf(d);
      if (!deck || v <= 0) return;
      const cue = ctx.hotcueOrPlace(d, 0); // set at the position heard, before the keylock latency changes
      transpose(d, deck, semitones);
      deck.seek(cue);
    });
    register(`shift.toneplay.${n}`, (d, v) => {
      const deck = deckOf(d);
      if (deck && v > 0) transpose(d, deck, semitones);
    });
  });

  panels.forEach((ui, d) => {
    const row = document.createElement('div');
    row.className = 'row pads toneplay';
    row.append('Toneplay');
    TONEPLAY_SEMITONES.forEach((semitones, n) => {
      const btn = document.createElement('button');
      btn.textContent = label(semitones);
      btn.title = `Hotcue 1 transposé de ${label(semitones)} demi-tons (Maj + clic : transposition seule)`;
      btn.dataset.led = `toneplay.${n}`; // no data-act: Maj + click only transposes
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatch(`${e.shiftKey ? 'shift.' : ''}toneplay.${n}`, d, 1);
      });
      row.append(btn);
      const lit = () => padOf(ctx.engine?.decks[d]?.transpose ?? 0) === n; // pad 1 before any track, as at init in Mixxx
      led(`toneplay.${n}`, d, lit);
      led(`shift.toneplay.${n}`, d, lit);
    });
    ui.section.append(row);
  });
}
