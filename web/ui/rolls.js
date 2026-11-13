// Roll and beatjump pad pages. Roll: a loop of 1/8 to 16 beats while the pad is held, slip forced, so
// playback goes back to where it would have been on release; the pad LED is lit while it rolls.
// Beatjump: jumps of ±1, 2, 4, 8 beats. Both need a beat grid; without one they do nothing and say so
// under the pads. Also on screen: roll buttons held like pads, beatjump buttons.
import { register, dispatch, led } from '../actions.js';
import { ROLL_BEATS, BEATJUMP_BEATS } from '../mapping.js';

const NOTICE_MS = 4000;
const beatLabel = (b) => (b < 1 ? `1/${1 / b}` : String(b));

/** Adds the roll and beatjump rows to every deck panel; ctx.rollPad[deck] is the pad rolling, or null. */
export function createRolls(ctx, panels) {
  ctx.rollPad = panels.map(() => null);
  const deckOf = (d) => (ctx.engine?.decks[d]?.buffer ? ctx.engine.decks[d] : null);
  const notices = [];
  const timers = [];

  function noGrid(d, what) {
    notices[d].textContent = `${what} impossible : pas de grille`;
    ctx.log(`Deck ${'AB'[d]} : ${what.toLowerCase()} impossible sans grille`);
    clearTimeout(timers[d]);
    timers[d] = setTimeout(() => { notices[d].textContent = ''; }, NOTICE_MS);
  }

  ROLL_BEATS.forEach((beats, n) => {
    register(`roll.${n}`, (d, v) => {
      const deck = deckOf(d);
      if (!deck) return;
      if (v <= 0) {
        if (ctx.rollPad[d] !== n) return; // another pad took over
        ctx.rollPad[d] = null;
        return deck.endRoll();
      }
      if (!deck.startRoll(beats)) return noGrid(d, 'Roll');
      ctx.rollPad[d] = n;
    });
  });
  BEATJUMP_BEATS.forEach((beats, n) => {
    register(`beatjump.${n}`, (d, v) => {
      const deck = deckOf(d);
      if (deck && v > 0 && !deck.beatJump(beats)) noGrid(d, 'Beatjump');
    });
  });
  // A new track ends the roll (the engine drops its loop and ghost on load).
  document.addEventListener('djing:load', ({ detail: { deck: d } }) => { ctx.rollPad[d] = null; });

  panels.forEach((ui, d) => {
    const rolls = document.createElement('div');
    rolls.className = 'row pads rolls';
    rolls.append('Roll');
    ROLL_BEATS.forEach((beats, n) => {
      const btn = document.createElement('button');
      btn.textContent = beatLabel(beats);
      btn.title = `Roll de ${beatLabel(beats)} temps tant que le bouton est maintenu`;
      btn.dataset.led = `roll.${n}`; // no data-act: held like a pad
      let held = false;
      const release = () => {
        if (held) dispatch(`roll.${n}`, d, 0);
        held = false;
      };
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        held = true;
        dispatch(`roll.${n}`, d, 1);
      });
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('click', (e) => e.stopPropagation());
      rolls.append(btn);
      led(`roll.${n}`, d, () => ctx.rollPad[d] === n && ctx.engine?.decks[d]?.roll !== null);
    });

    const jumps = document.createElement('div');
    jumps.className = 'row pads beatjumps';
    jumps.append('Beatjump');
    BEATJUMP_BEATS.forEach((beats, n) => {
      const btn = document.createElement('button');
      btn.textContent = `${beats < 0 ? '−' : '+'}${Math.abs(beats)}`;
      btn.title = `Saut de ${beats} temps`;
      btn.dataset.act = `beatjump.${n}`;
      jumps.append(btn);
    });
    notices[d] = document.createElement('span');
    notices[d].className = 'notice';
    jumps.append(notices[d]);
    ui.section.append(rolls, jumps);
  });
}
