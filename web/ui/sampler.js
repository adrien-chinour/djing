// Sampler: 16 slots, 1 to 8 on the pads of deck A, 9 to 16 on those of deck B, in sampler mode
// (0x30..0x37). A pad plays its slot from the start (again if it plays); SHIFT + pad (0x38..0x3F)
// stops it; an empty slot does nothing. Slots are filled by dragging a library row onto them, and
// saved as track ids in the settings store; they come back once the library is listed. Files are
// decoded when a slot is filled, never on a MIDI message. Output: sampler volume, then the MAIN (with
// its limiter) and, when the sampler PFL is on, the headphones. Pad LED lit while its slot plays.
import { register, dispatch, led, onLed, refreshLeds } from '../actions.js';
import { SAMPLER_PADS } from '../mapping.js';
import { get, put } from '../library/db.js';
import { TRACK_TYPE } from './library.js';

const $ = (sel) => document.querySelector(sel);
const SLOTS = 2 * SAMPLER_PADS;
const SETTINGS_KEY = 'sampler';
const DECODE_RATE = 48000; // when the audio is not started yet; the source node resamples

export function createSampler(ctx) {
  // id: track id (saved), name: shown, buffer: decoded audio, source: AudioBufferSourceNode playing.
  const slots = Array.from({ length: SLOTS }, () => ({ id: null, name: '', buffer: null, source: null }));
  let tracks = new Map(); // last library listing, by track id
  let volume = 1;
  let pflOn = false;
  let bus = null; // { volume, pfl } gain nodes, created on the engine at first use

  function output() {
    if (!ctx.engine) return null;
    if (!bus) {
      const { ctx: audio, master, cue } = ctx.engine;
      bus = { volume: audio.createGain(), pfl: audio.createGain() };
      bus.volume.gain.value = volume;
      bus.pfl.gain.value = pflOn ? 1 : 0;
      bus.volume.connect(master); // MAIN, through the master volume and the limiter
      bus.volume.connect(bus.pfl).connect(cue);
    }
    return bus.volume;
  }

  // Slot buttons: click plays, Maj + click stops; library rows drop onto them.
  const buttons = slots.map((slot, i) => {
    const btn = document.createElement('button');
    btn.className = 'slot';
    btn.dataset.slot = i;
    btn.addEventListener('click', (e) => dispatch(`${e.shiftKey ? 'shift.' : ''}sampler.${i % SAMPLER_PADS}`, Math.floor(i / SAMPLER_PADS), 1));
    btn.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(TRACK_TYPE)) return;
      e.preventDefault();
      btn.classList.add('drop');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('drop'));
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('drop');
      const id = e.dataTransfer.getData(TRACK_TYPE);
      if (!id) return;
      fill(i, id);
      save();
    });
    $('#samplerSlots').append(btn);
    return btn;
  });

  function show(i) {
    const slot = slots[i];
    const btn = buttons[i];
    btn.textContent = `${i + 1}${slot.name ? ` · ${slot.name}` : ''}`;
    btn.title = slot.id ? `${slot.id.split('|')[0]} (Maj + clic : arrêt)` : 'Vide : glisser un titre de la bibliothèque';
    btn.classList.toggle('empty', !slot.buffer);
  }

  function stop(slot) {
    const { source } = slot;
    if (!source) return;
    slot.source = null;
    source.stop();
  }

  /** Puts the track `id` in slot i, decoded from the library listing (kept as id until it is listed). */
  async function fill(i, id) {
    const slot = slots[i];
    stop(slot);
    const track = tracks.get(id);
    Object.assign(slot, { id, name: track ? `${track.artist ? `${track.artist} - ` : ''}${track.title}` : `${id.split('|')[0]} (introuvable)`, buffer: null });
    show(i);
    if (!track) return;
    buttons[i].textContent += ' (chargement…)';
    try {
      const audio = ctx.engine?.ctx ?? new OfflineAudioContext(2, 1, DECODE_RATE);
      const buffer = await audio.decodeAudioData(await track.file.arrayBuffer());
      if (slot.id !== id) return; // replaced meanwhile
      slot.buffer = buffer;
    } catch (err) {
      if (slot.id !== id) return;
      slot.name += ' (illisible)';
      ctx.log(`Sampler ${i + 1} : ${track.path} illisible (${err.message})`);
    }
    show(i);
    refreshLeds();
  }

  const save = () => put('settings', slots.map((s) => s.id), SETTINGS_KEY)
    .catch((err) => ctx.log(`Sampler non sauvegardé : ${err.message}`));

  for (let n = 0; n < SAMPLER_PADS; n++) {
    register(`sampler.${n}`, (d, v) => {
      const slot = slots[d * SAMPLER_PADS + n];
      const out = output();
      if (v <= 0 || !slot.buffer || !out) return;
      stop(slot);
      const source = ctx.engine.ctx.createBufferSource();
      source.buffer = slot.buffer;
      source.connect(out);
      source.onended = () => {
        source.disconnect();
        if (slot.source !== source) return;
        slot.source = null;
        refreshLeds();
      };
      slot.source = source;
      source.start();
    });
    register(`shift.sampler.${n}`, (d, v) => {
      if (v > 0) stop(slots[d * SAMPLER_PADS + n]);
    });
    for (const d of [0, 1]) {
      const playing = () => !!slots[d * SAMPLER_PADS + n].source;
      led(`sampler.${n}`, d, playing);
      led(`shift.sampler.${n}`, d, playing);
    }
  }
  onLed((name, d, on) => {
    const m = /^sampler\.(\d+)$/.exec(name);
    if (m && d !== null) buttons[d * SAMPLER_PADS + Number(m[1])].classList.toggle('on', on);
  });

  register('samplerVolume', (_d, v) => {
    volume = v;
    if (bus) bus.volume.gain.value = v;
    $('#samplerVolume').value = v;
  });
  register('samplerPfl', (_d, v) => {
    if (v <= 0) return;
    pflOn = !pflOn;
    if (bus) bus.pfl.gain.value = pflOn ? 1 : 0;
    $('#samplerPfl').classList.toggle('on', pflOn);
  });
  $('#samplerVolume').addEventListener('input', (e) => dispatch('samplerVolume', null, Number(e.target.value)));
  $('#samplerPfl').addEventListener('click', () => dispatch('samplerPfl', null, 1));

  // Saved slots come back once their tracks are listed; every listing decodes the filled slots again.
  document.addEventListener('djing:library', ({ detail }) => {
    tracks = new Map(detail.tracks.map((t) => [t.id, t]));
    slots.forEach((slot, i) => slot.id && fill(i, slot.id));
  });
  get('settings', SETTINGS_KEY).then((ids) => {
    if (!Array.isArray(ids)) return;
    ids.forEach((id, i) => {
      if (!id || slots[i].id || i >= SLOTS) return;
      Object.assign(slots[i], { id, name: `${id.split('|')[0]} (bibliothèque à ouvrir)` });
      show(i);
    });
  }).catch((err) => ctx.log(`Sampler indisponible : ${err.message}`));
  slots.forEach((_, i) => show(i));
}
