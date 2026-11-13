// Mixer column: crossfader, headphone and master volumes, pitch direction.
import { register, dispatch } from '../actions.js';

const $ = (sel) => document.querySelector(sel);

export function createMixer(ctx) {
  const xfader = $('#xfader');
  register('crossfader', (_d, v) => {
    if (!ctx.engine) return;
    ctx.engine.setCrossfader(v);
    xfader.value = v;
  });
  register('cueVolume', (_d, v) => ctx.engine && (ctx.engine.cue.gain.value = v));
  register('mainVolume', (_d, v) => ctx.engine && (ctx.engine.master.gain.value = v));

  xfader.addEventListener('input', (e) => dispatch('crossfader', null, Number(e.target.value)));
  $('#cueVol').addEventListener('input', (e) => dispatch('cueVolume', null, Number(e.target.value)));
  $('#mainVol').addEventListener('input', (e) => dispatch('mainVolume', null, Number(e.target.value)));
  $('#rateInvert').addEventListener('change', (e) => { ctx.rateInvert = e.target.checked; });
}
