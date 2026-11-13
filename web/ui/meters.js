// VU meters (deck A and B pre-fader, MAIN left and right after the limiter) and the limiter light.
// Every tick reads the peak of each analyser, shows it on screen and reports it with meter() for
// the controller's VU LEDs; ticks are 34 ms apart, so at most 30 messages per second per LED.
import { meter } from '../actions.js';

const TICK_MS = 34;
const FLOOR_DB = -48; // bottom of the scale: 0
const FALL_PER_TICK = 0.04; // the bar falls back slowly, rises at once
const LIMIT_LIGHT_DB = 3; // limiter light: gain reduction above this

/** Peak of the analyser's last window, as 0..1 on a FLOOR_DB..0 dBFS scale. */
function level(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(peak) - FLOOR_DB) / -FLOOR_DB));
}

/** Returns { start() }, called once the engine exists. */
export function createMeters(ctx) {
  const bar = (name, deck) => document.querySelector(`[data-meter="${name}"]${deck === null ? '' : `[data-deck="${deck}"]`}`);
  const limitLight = document.querySelector('#limit');

  function start() {
    const { engine } = ctx;
    const meters = [
      { name: 'vu', deck: 0, analyser: engine.decks[0].meter },
      { name: 'vu', deck: 1, analyser: engine.decks[1].meter },
      { name: 'vu.mainLeft', deck: null, analyser: engine.mainMeters[0] },
      { name: 'vu.mainRight', deck: null, analyser: engine.mainMeters[1] },
    ].map((m) => ({ ...m, el: bar(m.name, m.deck), buf: new Float32Array(m.analyser.fftSize), shown: 0 }));

    setInterval(() => {
      for (const m of meters) {
        const value = level(m.analyser, m.buf);
        meter(m.name, m.deck, value);
        m.shown = Math.max(value, m.shown - FALL_PER_TICK);
        m.el.style.setProperty('--level', m.shown);
        m.el.dataset.level = value.toFixed(3);
      }
      limitLight.classList.toggle('on', engine.reductionDb > LIMIT_LIGHT_DB);
      limitLight.title = `réduction du limiteur : ${engine.reductionDb.toFixed(1)} dB`;
    }, TICK_MS);
  }

  return { start };
}
