// Header: audio start, output devices, test tones, MIDI status.
import { Engine } from '../engine.js';
import { dispatch, onLed, onMeter, refreshLeds } from '../actions.js';
import { connectController } from '../midi.js';

const $ = (sel) => document.querySelector(sel);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** `onStart()` runs once the engine exists (ctx.engine), before the controller connects. */
export function createHeader(ctx, { onStart }) {
  const { log } = ctx;
  let controller = { setLed() {} };

  function showOutput() {
    const { engine } = ctx;
    const dest = engine.ctx.destination;
    const out = $('#out');
    const cue = engine.mode === '4ch' ? 'casque sur 3-4' : `casque sur « ${$('#cueDevice').selectedOptions[0]?.text ?? '?'} »`;
    out.textContent = `${engine.mode} : ${dest.maxChannelCount} canaux max, ${cue}, ${engine.ctx.sampleRate} Hz, latence ${((engine.ctx.outputLatency || engine.ctx.baseLatency) * 1000).toFixed(0)} ms`;
    const separate = engine.mode === '4ch' || $('#cueDevice').value !== $('#mainDevice').value;
    out.className = `pill ${separate ? 'ok' : 'warn'}`;
  }

  /**
   * Picks the outputs: "Inpulse MAIN" + "Inpulse Casque" (scripts/split-outputs.sh) when present,
   * else the controller card in 4-channel mode if the browser allows it, else the default output.
   */
  async function listDevices() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    for (const select of [$('#mainDevice'), $('#cueDevice')]) {
      select.innerHTML = '';
      for (const d of devices) select.add(new Option(d.label || `sortie ${d.deviceId.slice(0, 8)}`, d.deviceId === 'default' ? '' : d.deviceId));
      select.disabled = false;
    }
    const find = (re) => devices.find((d) => re.test(d.label));
    const main = find(/inpulse main/i);
    const cue = find(/inpulse casque/i);
    if (main && cue) {
      $('#mainDevice').value = main.deviceId;
      $('#cueDevice').value = cue.deviceId;
      await chooseDevices();
      return;
    }
    const card = find(/inpulse/i);
    if (card) {
      $('#mainDevice').value = card.deviceId;
      $('#cueDevice').value = card.deviceId;
      await chooseDevices();
      if (ctx.engine.route('4ch') !== '4ch') log('La carte de la platine n\'est vue qu\'en stéréo : lancer scripts/split-outputs.sh pour avoir le casque.');
    } else {
      log('Sortie de la platine introuvable : sortie par défaut.');
    }
    showOutput();
  }

  async function chooseDevices() {
    try {
      await ctx.engine.setMainDevice($('#mainDevice').value);
      await ctx.engine.setCueDevice($('#cueDevice').value);
      ctx.engine.route('split');
      log(`MAIN : ${$('#mainDevice').selectedOptions[0]?.text} ; casque : ${$('#cueDevice').selectedOptions[0]?.text}`);
    } catch (err) {
      log(`Échec du changement de sortie : ${err.message}`);
    }
    showOutput();
  }

  function updateMidi() {
    const el = $('#midi');
    el.textContent = `MIDI : ${controller.status ?? '—'}`;
    el.className = `pill ${controller.connected?.() ? 'ok' : 'warn'}`;
    if (controller.connected?.()) refreshLeds({ force: true });
  }

  $('#start').addEventListener('click', async () => {
    if (ctx.engine) return;
    ctx.engine = new Engine();
    window.djing = { engine: ctx.engine }; // for web/test and the devtools console
    await ctx.engine.ctx.resume();
    ctx.engine.setCrossfader(0.5);
    $('#start').classList.add('on');
    $('#start').textContent = 'Audio démarré';
    showOutput();
    await listDevices();
    onStart();

    try {
      controller = await connectController(dispatch, {
        raw: (bytes, entry) => log(`MIDI ${hex(bytes)}${entry ? ` → ${entry.action}` : ''}`),
        connection: () => updateMidi(),
      });
      onLed((name, deck, on) => controller.setLed(name, deck, on));
      onMeter((name, deck, value) => controller.setMeter(name, deck, value));
    } catch (err) {
      log(`Accès MIDI refusé : ${err.message}`);
    }
    updateMidi();
  });

  $('#mainDevice').addEventListener('change', chooseDevices);
  $('#cueDevice').addEventListener('change', chooseDevices);
  $('#labels').addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      if (ctx.engine) await listDevices();
    } catch (err) {
      log(`Autorisation refusée : ${err.message}`);
    }
  });
  $('#toneMain').addEventListener('click', () => ctx.engine?.testTone(0));
  $('#toneCue').addEventListener('click', () => ctx.engine?.testTone(1));
}
