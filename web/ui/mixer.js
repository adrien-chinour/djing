// Mixer column: crossfader, headphone volume and cue/master mix, split cue, master volume, pitch direction.
import { register, dispatch } from '../actions.js';

const $ = (sel) => document.querySelector(sel);

export function createMixer(ctx) {
  const xfader = $('#xfader');
  register('crossfader', (_d, v) => {
    if (!ctx.engine) return;
    ctx.engine.setCrossfader(v);
    xfader.value = v;
  });
  register('cueVolume', (_d, v) => ctx.engine && (ctx.engine.phones.gain.value = v));
  register('cueMix', (_d, v) => {
    if (!ctx.engine) return;
    ctx.engine.setCueMix(v);
    $('#cueMix').value = v;
  });
  register('splitCue', (_d, on) => {
    if (!ctx.engine) return;
    ctx.engine.setSplitCue(on);
    $('#splitCue').checked = on;
  });
  register('mainVolume', (_d, v) => ctx.engine && (ctx.engine.master.gain.value = v));

  xfader.addEventListener('input', (e) => dispatch('crossfader', null, Number(e.target.value)));
  $('#cueVol').addEventListener('input', (e) => dispatch('cueVolume', null, Number(e.target.value)));
  $('#cueMix').addEventListener('input', (e) => dispatch('cueMix', null, Number(e.target.value)));
  $('#splitCue').addEventListener('change', (e) => dispatch('splitCue', null, e.target.checked));
  $('#mainVol').addEventListener('input', (e) => dispatch('mainVolume', null, Number(e.target.value)));
  $('#rateInvert').addEventListener('change', (e) => { ctx.rateInvert = e.target.checked; });
}
