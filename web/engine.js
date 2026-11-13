// Audio engine: two decks, a mixer, a MAIN bus and a headphone cue bus.
// The Inpulse 300 MK2 card carries MAIN on channels 1-2 and the headphones on 3-4 (README.md,
// "Matériel"). Two ways to reach them:
// - "4ch": one 4-channel output (when the browser exposes more than 2 channels);
// - "split": two stereo outputs, MAIN through the AudioContext and the cue through an <audio>
//   element, each sent to its own device. Chrome on Linux caps outputs at 2 channels, so there
//   scripts/split-outputs.sh exposes the card as two stereo sinks, "Inpulse MAIN" and "Inpulse Casque".

import { FxUnit } from './fx/unit.js';
import SignalsmithStretch from './vendor/signalsmith-stretch.js';

const EQ_CUT_DB = -26;
const EQ_BOOST_DB = 6;

// Scratch, values of DJCi300._scratchEnable and DJCi300.scratchShiftMultiplier in
// /usr/share/mixxx/controllers/Hercules-DJControl-Inpulse-300-script.js.
export const TICKS_PER_REV = 248;
const RPM = 33 + 1 / 3;
export const TICK_SECONDS = 60 / RPM / TICKS_PER_REV; // track seconds per tick
export const SEEK_MULTIPLIER = 4;
const ALPHA = 1 / 8;
const BETA = ALPHA / 32;
const STEP_S = 0.001; // alpha-beta filter step, as in Mixxx
const TIMER_MS = 5;
const IDLE_S = 0.05; // no tick for this long and a slow filter: the wheel has stopped
const KEYLOCK_MAX_DEVIATION = 0.5; // keylock is bypassed beyond ±50 % of speed, and in reverse

/** Knob 0..1 with a centre detent at 0.5 -> dB (kill at 0, +6 dB at 1). */
export function knobToDb(v) {
  return v < 0.5 ? EQ_CUT_DB * (1 - v / 0.5) : EQ_BOOST_DB * ((v - 0.5) / 0.5);
}

export class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain(); // master volume, then the limiter (worklets/limiter.js)
    this.main = this.ctx.createGain(); // limited MAIN, sent to the outputs by route()
    this.master.connect(this.main); // until the limiter module is loaded
    this.mainMeters = [this.ctx.createAnalyser(), this.ctx.createAnalyser()]; // left, right
    this.mainSplit = this.ctx.createChannelSplitter(2);
    this.mainMeters.forEach((meter, i) => this.mainSplit.connect(meter, i));
    this.reductionDb = 0; // gain reduction of the limiter, worst over the last ~33 ms
    this.ctx.audioWorklet.addModule(new URL('./worklets/limiter.js', import.meta.url)).then(() => {
      const limiter = new AudioWorkletNode(this.ctx, 'limiter', {
        outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
      });
      limiter.port.onmessage = (e) => { this.reductionDb = e.data; };
      this.master.disconnect();
      this.master.connect(limiter).connect(this.main);
    });
    this.cue = this.ctx.createGain();
    this.cueStream = this.ctx.createMediaStreamDestination();
    this.cueElement = new Audio();
    this.cueElement.srcObject = this.cueStream.stream;
    // Deck players run in an AudioWorklet (worklets/deck-player.js); decks wait for it in load().
    this.ready = this.ctx.audioWorklet.addModule(new URL('./worklets/deck-player.js', import.meta.url));
    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.crossfader = 0.5;
    this.mode = null;
    this.route('split');
  }

  /** Rewires MAIN and cue for "4ch" (one device) or "split" (two stereo devices). */
  route(mode) {
    if (mode === '4ch' && this.ctx.destination.maxChannelCount < 4) mode = 'split';
    this.main.disconnect();
    this.main.connect(this.mainSplit);
    this.cue.disconnect();
    this.merger?.disconnect();
    const dest = this.ctx.destination;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    if (mode === '4ch') {
      this.merger = this.ctx.createChannelMerger(4);
      [[this.main, 0], [this.cue, 2]].forEach(([bus, first]) => {
        const split = this.ctx.createChannelSplitter(2);
        bus.connect(split);
        split.connect(this.merger, 0, first);
        split.connect(this.merger, 1, first + 1);
      });
      dest.channelCount = 4;
      this.merger.connect(dest);
      this.cueElement.pause();
    } else {
      dest.channelCount = 2;
      this.main.connect(dest);
      this.cue.connect(this.cueStream);
      this.cueElement.play().catch(() => {});
    }
    this.mode = mode;
    return mode;
  }

  /** MAIN device: the AudioContext output ('' = system default). */
  async setMainDevice(deviceId) {
    if (!this.ctx.setSinkId) throw new Error('AudioContext.setSinkId non supporté (Chrome 110+)');
    await this.ctx.setSinkId(deviceId);
    return this.route(this.mode);
  }

  /** Headphone device, used in "split" mode only. */
  async setCueDevice(deviceId) {
    await this.cueElement.setSinkId(deviceId);
    await this.cueElement.play().catch(() => {});
  }

  setCrossfader(v) {
    this.crossfader = v;
    // Constant-power curve.
    this.decks[0].xfade.gain.value = Math.cos((v * Math.PI) / 2);
    this.decks[1].xfade.gain.value = Math.sin((v * Math.PI) / 2);
  }

  /** Plays a short sine on MAIN (0) or headphones (1) to check the routing. */
  testTone(target) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = target === 0 ? 440 : 880;
    g.gain.setValueAtTime(0.2, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 1);
    osc.connect(g).connect(target === 0 ? this.master : this.cue);
    osc.start();
    osc.stop(this.ctx.currentTime + 1);
  }
}

class Deck {
  constructor(engine, index) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.index = index;
    this.buffer = null;
    this.player = null; // AudioWorkletNode, created on the first load
    this.playing = false;
    this.offset = 0; // track position (s) while stopped
    this.report = { position: 0, time: 0 }; // last position reported by the worklet
    this.gen = 0; // bumped on every command, so reports sent before it are ignored
    this.rate = 1; // pitch fader
    this.bend = 0; // temporary nudge from the jog wheel
    this.vinyl = true; // vinyl mode: touching the wheel scratches
    this.touched = false; // wheel top surface held
    this.scratch = null; // { target, x, v, idle, timer } while the wheel drives playback
    this.cuePoint = 0;
    this.rateRange = 0.08;
    this.bpm = null; // track BPM, null while unknown (effects then assume 120)
    this.keylock = false;
    this.transpose = 0; // semitones, -12..12
    this.stretch = null; // Signalsmith Stretch node, pitch shifter after the player
    this.latency = 0; // seconds added by the stretch node
    this.stretched = false; // audio goes through the stretch node (keylock on or transposed)
    this.semitones = 0; // pitch shift last sent to the stretch node

    this.trim = ctx.createGain();
    // Player -> dry -> trim, or player -> stretch -> wet -> trim (see retune()).
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.dry.connect(this.trim);
    this.wet.connect(this.trim);
    this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250 });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.7 });
    this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000 });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: ctx.sampleRate / 2 });
    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();
    this.pfl = ctx.createGain();
    this.pfl.gain.value = 0;
    this.meter = ctx.createAnalyser(); // pre-fader level
    // Effect unit after the EQ and filter, before the fader (and heard on PFL and the meter).
    this.fx = new FxUnit(ctx, { tempo: () => (this.bpm ? this.bpm * this.rate : null) });
    this.trim.connect(this.low).connect(this.mid).connect(this.high).connect(this.filter).connect(this.fx.input);
    this.fx.output.connect(this.fader).connect(this.xfade).connect(engine.master);
    this.fx.output.connect(this.pfl).connect(engine.cue); // pre-fader listen
    this.fx.output.connect(this.meter);
  }

  async load(file) {
    this.stop();
    const buffer = await this.engine.ctx.decodeAudioData(await file.arrayBuffer());
    await (this.nodes ??= this.createNodes());
    // Copies, so the AudioBuffer stays usable for the waveform; sent once, by transfer.
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
    this.player.port.postMessage({ type: 'load', channels }, channels.map((ch) => ch.buffer));
    this.buffer = buffer;
    this.name = file.name;
    this.offset = 0;
    this.cuePoint = 0;
    this.send({ type: 'speed', speed: this.speed });
  }

  /** Player worklet, then the stretch node that keeps the key or transposes. */
  async createNodes() {
    const ctx = this.engine.ctx;
    await this.engine.ready;
    this.player = new AudioWorkletNode(ctx, 'deck-player', { numberOfInputs: 0, outputChannelCount: [2] });
    this.player.port.onmessage = (e) => this.onReport(e.data);
    this.player.connect(this.dry);
    const stretch = await SignalsmithStretch(ctx, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
    });
    this.latency = await stretch.latency();
    stretch.start();
    this.player.connect(stretch).connect(this.wet);
    this.stretch = stretch;
    this.retune();
  }

  /** Sends a command to the worklet; reports sent before it are now stale. */
  send(msg) {
    this.player?.port.postMessage({ ...msg, gen: ++this.gen });
    if (msg.type === 'speed') this.retune();
  }

  /**
   * The player resamples (pitch follows speed); the stretch node then shifts the pitch by the
   * transposition, minus the speed's own shift while keylock holds. Keylock is bypassed in reverse
   * and beyond ±50 %. Neither keylock nor transposition: the direct path, without latency.
   */
  retune() {
    const speed = this.speed;
    const locked = this.keylock && speed > 0 && Math.abs(speed - 1) <= KEYLOCK_MAX_DEVIATION;
    const semitones = this.transpose - (locked ? 12 * Math.log2(speed) : 0);
    if (this.stretch && semitones !== this.semitones) this.stretch.schedule({ semitones });
    this.semitones = semitones;
    const stretched = !!this.stretch && (this.keylock || this.transpose !== 0);
    if (stretched === this.stretched) return;
    this.stretched = stretched;
    const now = this.engine.ctx.currentTime;
    this.dry.gain.setTargetAtTime(stretched ? 0 : 1, now, 0.003);
    this.wet.gain.setTargetAtTime(stretched ? 1 : 0, now, 0.003);
  }

  setKeylock(on) {
    this.keylock = on;
    this.retune();
  }

  /** Transposition in semitones, -12..12. */
  setTranspose(semitones) {
    this.transpose = Math.max(-12, Math.min(12, Math.round(semitones)));
    this.retune();
  }

  /** Latency of the audio heard: the stretch node's while audio goes through it. */
  get delay() {
    return this.stretched ? this.latency : 0;
  }

  /** True while the worklet plays: deck playing, or wheel scratching. */
  get running() {
    return this.playing || !!this.scratch;
  }

  onReport(msg) {
    if (msg.gen !== this.gen || !this.running) return;
    if (msg.type === 'ended') {
      this.playing = false;
      this.offset = msg.position;
      if (this.scratch) {
        clearInterval(this.scratch.timer);
        this.scratch = null;
        this.send({ type: 'speed', speed: this.speed });
      }
    } else {
      this.report = { position: msg.position, time: msg.time };
    }
  }

  get speed() {
    return this.scratch ? this.scratch.v : this.rate + this.bend;
  }

  /** Read position of the player, extrapolated from the last worklet report while playing. */
  get playhead() {
    if (!this.running) return this.offset;
    const p = this.report.position + (this.engine.ctx.currentTime - this.report.time) * this.speed;
    return Math.min(Math.max(0, p), this.duration);
  }

  /** Position heard: the playhead, minus what the stretch node still holds. */
  get position() {
    if (!this.running || !this.delay) return this.playhead;
    return Math.min(Math.max(0, this.playhead - this.delay * this.speed), this.duration);
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  rebase() {
    this.report = { position: this.playhead, time: this.engine.ctx.currentTime };
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (!this.scratch) {
      this.report = { position: this.offset, time: this.engine.ctx.currentTime };
      this.send({ type: 'play' });
    }
    this.playing = true;
  }

  stop() {
    if (!this.playing) return;
    this.offset = this.playhead;
    this.playing = false;
    if (!this.scratch) this.send({ type: 'stop', position: this.offset });
  }

  toggle() {
    this.playing ? this.stop() : this.play();
  }

  seek(seconds) {
    const position = Math.min(Math.max(0, seconds), this.duration);
    if (this.running) this.report = { position, time: this.engine.ctx.currentTime };
    else this.offset = position;
    this.send({ type: 'seek', position });
  }

  /** CDJ-style cue: when stopped, set the cue point; when playing, jump back to it and stop. */
  cuePress() {
    if (this.playing) {
      this.stop();
      this.seek(this.cuePoint);
    } else {
      this.cuePoint = this.offset;
    }
  }

  applySpeed() {
    if (this.running) this.rebase();
    this.send({ type: 'speed', speed: this.speed });
  }

  /** Pitch fader -1..1 -> ±rateRange. */
  setRate(v) {
    this.rate = 1 + v * this.rateRange;
    this.applySpeed();
    this.fx.retime();
  }

  /** Track BPM (null when unknown); tempo-synced effects follow it, scaled by the pitch. */
  setBpm(bpm) {
    this.bpm = bpm;
    this.fx.retime();
  }

  /** Jog wheel: nudge while playing, search while stopped or touched. */
  jog(ticks, touched) {
    if (!this.buffer) return;
    if (this.playing && !touched) {
      this.bend = Math.max(-0.5, Math.min(0.5, this.bend + ticks * 0.02));
      this.applySpeed();
      clearTimeout(this.bendTimer);
      this.bendTimer = setTimeout(() => {
        this.bend = 0;
        this.applySpeed();
      }, 80);
    } else {
      this.seek(this.playhead + ticks * 0.02);
    }
  }

  /** Wheel top surface touched or released: scratch in vinyl mode. */
  touch(on) {
    this.touched = on;
    if (on && this.vinyl) this.startScratch();
    else if (!on) this.stopScratch();
  }

  /** Ticks of the touched wheel: scratch while scratching, else the POC jog. */
  touchedJog(ticks) {
    if (this.scratch && this.touched) this.scratchTicks(ticks);
    else this.jog(ticks, true);
  }

  /** SHIFT + wheel: fast search, a scratch SEEK_MULTIPLIER times faster, ending when the wheel stops. */
  seekJog(ticks) {
    this.startScratch();
    this.scratchTicks(ticks * SEEK_MULTIPLIER);
  }

  setVinyl(on) {
    this.vinyl = on;
    if (!on && this.scratch) this.stopScratch();
  }

  /** The wheel drives playback: an alpha-beta filter (as in Mixxx) turns ticks into a speed. */
  startScratch() {
    if (!this.buffer || this.scratch) return;
    this.rebase();
    if (!this.playing) {
      this.report = { position: this.offset, time: this.engine.ctx.currentTime };
      this.send({ type: 'play' });
    }
    this.scratch = { target: 0, x: 0, v: 0, idle: 0, last: performance.now() };
    this.scratch.timer = setInterval(() => this.scratchStep(), TIMER_MS);
    this.applySpeed();
  }

  scratchTicks(ticks) {
    if (!this.scratch) return;
    this.scratch.target += ticks * TICK_SECONDS;
    this.scratch.idle = 0;
  }

  /** Runs the filter in 1 ms steps up to now, then sends the filtered speed to the worklet. */
  scratchStep() {
    const s = this.scratch;
    const now = performance.now();
    const steps = Math.min(100, Math.round((now - s.last) / (STEP_S * 1000)));
    s.last += steps * STEP_S * 1000;
    for (let i = 0; i < steps; i++) {
      const residual = s.target - (s.x + s.v * STEP_S);
      s.x += s.v * STEP_S + ALPHA * residual;
      s.v += (BETA / STEP_S) * residual;
    }
    s.idle += steps * STEP_S;
    if (s.idle > IDLE_S && Math.abs(s.v) < 0.05) {
      // The wheel has stopped: stand still, and end a SHIFT search once the wheel is released.
      s.v = 0;
      s.x = s.target;
      if (!this.touched) return this.stopScratch();
    }
    this.rebase();
    this.send({ type: 'speed', speed: this.speed });
  }

  /** Back to the pitch fader speed if the deck was playing, else stop where the wheel left it. */
  stopScratch() {
    if (!this.scratch) return;
    this.rebase();
    clearInterval(this.scratch.timer);
    this.scratch = null;
    if (this.playing) {
      this.applySpeed();
    } else {
      this.offset = this.report.position;
      this.send({ type: 'stop', position: this.offset });
      this.send({ type: 'speed', speed: this.speed });
    }
  }

  setEq(band, v) {
    this[band].gain.value = knobToDb(v);
  }

  setGain(v) {
    this.trim.gain.value = Math.pow(10, knobToDb(v) / 20);
  }

  setVolume(v) {
    this.fader.gain.value = v * v;
  }

  /** One-knob filter: lowpass below centre, highpass above, bypass in the middle. */
  setFilter(v) {
    const nyquist = this.engine.ctx.sampleRate / 2;
    if (Math.abs(v - 0.5) < 0.02) {
      this.filter.type = 'lowpass';
      this.filter.frequency.value = nyquist;
    } else if (v < 0.5) {
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 20 * Math.pow(nyquist / 20, v / 0.5);
    } else {
      this.filter.type = 'highpass';
      this.filter.frequency.value = 20 * Math.pow(10000 / 20, (v - 0.5) / 0.5);
    }
  }

  setPfl(on) {
    this.pflOn = on;
    this.pfl.gain.value = on ? 1 : 0;
  }

  /** Peak overview for the waveform, `bins` values in 0..1. */
  peaks(bins) {
    const data = this.buffer.getChannelData(0);
    const step = Math.floor(data.length / bins);
    const out = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      let max = 0;
      for (let j = i * step; j < (i + 1) * step; j += 16) max = Math.max(max, Math.abs(data[j]));
      out[i] = max;
    }
    return out;
  }
}
