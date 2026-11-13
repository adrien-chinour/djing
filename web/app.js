// UI glue: on-screen controls and the controller drive the same engine calls.
import { Engine } from './engine.js';
import { connectController } from './midi.js';

const $ = (sel, root = document) => root.querySelector(sel);
const logEl = $('#log');
const log = (msg) => {
  logEl.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};

let engine = null;
let controller = { setLed() {} };
let rateInvert = true;
const decksUi = [];

// --- Deck panels -----------------------------------------------------------

for (const section of document.querySelectorAll('.deck')) {
  const index = Number(section.dataset.deck);
  section.append($('#deckTpl').content.cloneNode(true));
  $('h2', section).textContent = index === 0 ? 'Deck A' : 'Deck B';
  const ui = { section, canvas: $('canvas', section), peaks: null, name: $('.name', section), time: $('.time', section), rate: $('.rate', section) };
  decksUi[index] = ui;

  const load = async (file) => {
    if (!engine) return log('Démarrer l\'audio avant de charger un titre');
    ui.name.textContent = `chargement de ${file.name}…`;
    await engine.decks[index].load(file);
    ui.name.textContent = file.name;
    ui.peaks = engine.decks[index].peaks(ui.canvas.width);
    refreshLeds(index);
  };
  $('input[type=file]', section).addEventListener('change', (e) => e.target.files[0] && load(e.target.files[0]));
  section.addEventListener('dragover', (e) => { e.preventDefault(); section.classList.add('drop'); });
  section.addEventListener('dragleave', () => section.classList.remove('drop'));
  section.addEventListener('drop', (e) => {
    e.preventDefault();
    section.classList.remove('drop');
    if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
  });
  ui.canvas.addEventListener('click', (e) => {
    const deck = engine?.decks[index];
    if (!deck?.buffer) return;
    const r = ui.canvas.getBoundingClientRect();
    deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
  });
  for (const btn of section.querySelectorAll('[data-act]')) {
    btn.addEventListener('click', () => button(index, btn.dataset.act, true));
  }
  for (const input of section.querySelectorAll('[data-knob]')) {
    input.addEventListener('input', () => {
      const v = Number(input.value);
      input.dataset.knob === 'rate' ? rate(index, v, false) : knob(index, input.dataset.knob, v, false);
    });
  }
}

// --- Actions shared by UI and controller ------------------------------------

function button(index, name, pressed) {
  const deck = engine?.decks[index];
  if (!deck || !pressed) return;
  if (name === 'play') deck.toggle();
  if (name === 'cue') deck.cuePress();
  if (name === 'pfl') deck.setPfl(!deck.pflOn);
  refreshLeds(index);
}

function knob(index, name, v, fromController) {
  const deck = engine?.decks[index];
  if (!deck) return;
  if (name === 'volume') deck.setVolume(v);
  else if (name === 'gain') deck.setGain(v);
  else if (name === 'filter') deck.setFilter(v);
  else deck.setEq(name, v);
  if (fromController) $(`[data-knob="${name}"]`, decksUi[index].section).value = v;
}

function rate(index, v, fromController) {
  const deck = engine?.decks[index];
  if (!deck) return;
  const value = fromController && rateInvert ? -v : v;
  deck.setRate(value);
  if (fromController) $('[data-knob="rate"]', decksUi[index].section).value = value;
}

function refreshLeds(index) {
  const deck = engine.decks[index];
  const s = decksUi[index].section;
  $('[data-act=play]', s).classList.toggle('on', deck.playing);
  $('[data-act=pfl]', s).classList.toggle('on', !!deck.pflOn);
  controller.setLed(index, 'play', deck.playing);
  controller.setLed(index, 'cue', !!deck.buffer && !deck.playing);
  controller.setLed(index, 'pfl', !!deck.pflOn);
}

// --- Header: audio start, output device, test tones, MIDI -------------------

function showOutput() {
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
    if (engine.route('4ch') !== '4ch') log('La carte de la platine n\'est vue qu\'en stéréo : lancer scripts/split-outputs.sh pour avoir le casque.');
  } else {
    log('Sortie de la platine introuvable : sortie par défaut.');
  }
  showOutput();
}

async function chooseDevices() {
  try {
    await engine.setMainDevice($('#mainDevice').value);
    await engine.setCueDevice($('#cueDevice').value);
    engine.route('split');
    log(`MAIN : ${$('#mainDevice').selectedOptions[0]?.text} ; casque : ${$('#cueDevice').selectedOptions[0]?.text}`);
  } catch (err) {
    log(`Échec du changement de sortie : ${err.message}`);
  }
  showOutput();
}

$('#start').addEventListener('click', async () => {
  if (engine) return;
  engine = new Engine();
  await engine.ctx.resume();
  engine.setCrossfader(0.5);
  $('#start').classList.add('on');
  $('#start').textContent = 'Audio démarré';
  showOutput();
  await listDevices();
  setInterval(draw, 50);

  try {
    controller = await connectController({
      button: (d, name, pressed) => (name === 'wheelTouch' ? null : button(d, name, pressed)),
      knob: (d, name, v) => knob(d, name, v, true),
      rate: (d, v) => rate(d, v, true),
      crossfader: (v) => { engine.setCrossfader(v); $('#xfader').value = v; },
      jog: (d, ticks, touched) => engine.decks[d].jog(ticks, touched),
      raw: (bytes) => log(`MIDI ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`),
      connection: () => updateMidi(),
    });
  } catch (err) {
    log(`Accès MIDI refusé : ${err.message}`);
  }
  updateMidi();
});

function updateMidi() {
  const el = $('#midi');
  el.textContent = `MIDI : ${controller.status ?? '—'}`;
  el.className = `pill ${controller.connected?.() ? 'ok' : 'warn'}`;
  if (controller.connected?.()) engine.decks.forEach((_, i) => refreshLeds(i));
}

$('#mainDevice').addEventListener('change', chooseDevices);
$('#cueDevice').addEventListener('change', chooseDevices);
$('#labels').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    if (engine) await listDevices();
  } catch (err) {
    log(`Autorisation refusée : ${err.message}`);
  }
});
$('#toneMain').addEventListener('click', () => engine?.testTone(0));
$('#toneCue').addEventListener('click', () => engine?.testTone(1));
$('#xfader').addEventListener('input', (e) => engine?.setCrossfader(Number(e.target.value)));
$('#cueVol').addEventListener('input', (e) => engine && (engine.cue.gain.value = Number(e.target.value)));
$('#mainVol').addEventListener('input', (e) => engine && (engine.master.gain.value = Number(e.target.value)));
$('#rateInvert').addEventListener('change', (e) => { rateInvert = e.target.checked; });

// --- Drawing ----------------------------------------------------------------

const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function draw() {
  engine.decks.forEach((deck, i) => {
    const ui = decksUi[i];
    const g = ui.canvas.getContext('2d');
    const { width: w, height: h } = ui.canvas;
    g.clearRect(0, 0, w, h);
    if (!ui.peaks) return;
    const accent = getComputedStyle(ui.section).getPropertyValue('--accent');
    const head = Math.floor((deck.position / deck.duration) * w);
    for (let x = 0; x < w; x++) {
      const p = ui.peaks[x] * h * 0.48;
      g.fillStyle = x < head ? '#555b66' : accent;
      g.fillRect(x, h / 2 - p, 1, p * 2);
    }
    g.fillStyle = '#fff';
    g.fillRect(head, 0, 2, h);
    g.fillStyle = '#ffcc4d';
    g.fillRect(Math.floor((deck.cuePoint / deck.duration) * w), 0, 2, h);
    ui.time.textContent = `${fmt(deck.position)} / ${fmt(deck.duration)}`;
    ui.rate.textContent = `${deck.rate >= 1 ? '+' : '−'}${(Math.abs(deck.rate - 1) * 100).toFixed(2)} %`;
  });
}
