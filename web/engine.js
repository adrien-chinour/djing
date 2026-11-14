// Audio engine: two decks, a mixer, a MAIN bus and a headphone cue bus.
// The Inpulse 300 MK2 card carries MAIN on channels 1-2 and the headphones on 3-4 (README.md,
// "Matériel"). Two ways to reach them:
// - "4ch": one 4-channel output (when the browser exposes more than 2 channels);
// - "split": two stereo outputs, MAIN through the AudioContext and the cue through an <audio>
//   element, each sent to its own device. Chrome on Linux caps outputs at 2 channels, so there
//   scripts/split-outputs.sh exposes the card as two stereo sinks, "Inpulse MAIN" and "Inpulse Casque".

import { FxUnit } from './fx/unit.js';
import { Sync, RATE_RANGES } from './sync.js';
import SignalsmithStretch from './vendor/signalsmith-stretch.js';

const EQ_CUT_DB = -26;
const EQ_BOOST_DB = 6;

// Scratch, values of DJCi300._scratchEnable and DJCi300.scratchShiftMultiplier in
// /usr/share/mixxx/controllers/Hercules-DJControl-Inpulse-300-script.js. The alpha-beta filter of
// the scratch runs in the player worklet (worklets/deck-player.js).
export const TICKS_PER_REV = 248;
const RPM = 33 + 1 / 3;
export const TICK_SECONDS = 60 / RPM / TICKS_PER_REV; // track seconds per tick
export const SEEK_MULTIPLIER = 4;
const KEYLOCK_MAX_DEVIATION = 0.5; // keylock is bypassed beyond ±50 % of speed, and in reverse

// Loops: length bounds in beats with a beat grid, shortest loop in seconds without one.
export const LOOP_MIN_BEATS = 1 / 32;
export const LOOP_MAX_BEATS = 64;
const LOOP_MIN_SECONDS = 0.01;

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
    this.cue = this.ctx.createGain(); // PFL bus
    // Headphone mix (see mixPhones()): cue/master blend or split cue, then the headphone volume.
    this.phones = this.ctx.createGain();
    this.masterTap = this.ctx.createGain(); // limited MAIN, fed by route()
    this.cueMix = this.ctx.createGain();
    this.masterMix = this.ctx.createGain();
    const mono = () => this.ctx.createGain({ channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.cueMono = mono();
    this.masterMono = mono();
    this.phonesMerger = this.ctx.createChannelMerger(2);
    this.splitCue = false;
    this.cueStream = this.ctx.createMediaStreamDestination();
    this.cueElement = new Audio();
    this.cueElement.srcObject = this.cueStream.stream;
    // Deck players run in an AudioWorklet (worklets/deck-player.js); decks wait for it in load().
    this.ready = this.ctx.audioWorklet.addModule(new URL('./worklets/deck-player.js', import.meta.url));
    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.sync = new Sync(this);
    this.crossfader = 0.5;
    this.mode = null;
    this.setCueMix(0);
    this.mixPhones();
    this.route('split');
  }

  /** Headphone cue/master knob: 0 = cue only, 1 = master only, constant-power curve. */
  setCueMix(v) {
    this.cueMix.gain.value = Math.cos((v * Math.PI) / 2);
    this.masterMix.gain.value = Math.sin((v * Math.PI) / 2);
  }

  /** Split cue: cue in mono on the left headphone channel, master in mono on the right (knob ignored). */
  setSplitCue(on) {
    this.splitCue = on;
    this.mixPhones();
  }

  /** Wires the cue bus and the limited MAIN into the headphone volume, blended or split. */
  mixPhones() {
    [this.cue, this.masterTap, this.cueMix, this.masterMix, this.cueMono, this.masterMono, this.phonesMerger].forEach((n) => n.disconnect());
    if (this.splitCue) {
      this.cue.connect(this.cueMono).connect(this.phonesMerger, 0, 0);
      this.masterTap.connect(this.masterMono).connect(this.phonesMerger, 0, 1);
      this.phonesMerger.connect(this.phones);
    } else {
      this.cue.connect(this.cueMix).connect(this.phones);
      this.masterTap.connect(this.masterMix).connect(this.phones);
    }
  }

  /** Rewires MAIN and cue for "4ch" (one device) or "split" (two stereo devices). */
  route(mode) {
    if (mode === '4ch' && this.ctx.destination.maxChannelCount < 4) mode = 'split';
    this.main.disconnect();
    this.main.connect(this.mainSplit);
    this.main.connect(this.masterTap);
    this.phones.disconnect();
    this.merger?.disconnect();
    const dest = this.ctx.destination;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    if (mode === '4ch') {
      this.merger = this.ctx.createChannelMerger(4);
      [[this.main, 0], [this.phones, 2]].forEach(([bus, first]) => {
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
      this.phones.connect(this.cueStream);
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
    osc.connect(g).connect(target === 0 ? this.master : this.phones);
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
    this.quantize = false; // Q: new cue points snap to the nearest beat, auto loops start on the current beat
    this.touched = false; // wheel top surface held
    this.scratch = null; // { v } while the wheel drives playback, v the speed last reported by the worklet
    this.cuePoint = 0;
    this.rateRange = RATE_RANGES[0];
    this.pitch = 0; // pitch fader, -1..1
    this.bpm = null; // track BPM, null while unknown (effects then assume 120)
    this.firstBeat = 0; // first beat of the grid (s)
    this.syncMaster = null; // deck whose phase the player follows (see sync.js)
    this.keylock = false;
    this.transpose = 0; // semitones, -12..12
    this.toneplay = false; // the transposition comes from a toneplay pad: keylock forced (see keylocked)
    this.stretch = null; // Signalsmith Stretch node, pitch shifter after the player
    this.latency = 0; // seconds added by the stretch node
    this.stretched = false; // audio goes through the stretch node (keylock on or transposed)
    this.semitones = 0; // pitch shift last sent to the stretch node
    this.grid = null; // { bpm, firstBeat } of the loaded track, null without a beat grid
    this.loop = null; // { start, end } (s) while a loop is active
    this.loopStart = null; // last LOOP IN position
    this.slip = false; // SLIP: scratch, loops and held hotcues return to where playback would have been
    this.slipHolds = new Set(); // what holds the ghost position: 'scratch', 'loop', 'hotcue', 'roll'
    this.roll = null; // beats of the loop roll while a roll pad is held
    this.ghost = null; // { position, time, speed } of the worklet's ghost position while held

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
    this.loop = null;
    this.loopStart = null;
    this.grid = null;
    this.roll = null;
    this.slipHolds.clear(); // the worklet drops its ghost on load
    this.ghost = null;
    this.send({ type: 'speed', speed: this.speed });
  }

  /** Player worklet, then the stretch node that keeps the key or transposes. */
  async createNodes() {
    const ctx = this.engine.ctx;
    await this.engine.ready;
    this.player = new AudioWorkletNode(ctx, 'deck-player', {
      numberOfInputs: 0, outputChannelCount: [2], processorOptions: { index: this.index },
    });
    this.player.port.onmessage = (e) => this.onReport(e.data);
    this.tell({ type: 'grid', bpm: this.bpm, firstBeat: this.firstBeat });
    this.updateSync();
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

  /** Sends a setting to the worklet, without making its reports stale. */
  tell(msg) {
    this.player?.port.postMessage(msg);
  }

  /**
   * The player resamples (pitch follows speed); the stretch node then shifts the pitch by the
   * transposition, minus the speed's own shift while keylock holds. Keylock is bypassed in reverse
   * and beyond ±50 %. Neither keylock nor transposition: the direct path, without latency.
   */
  retune() {
    const speed = this.speed;
    const locked = this.keylocked && speed > 0 && Math.abs(speed - 1) <= KEYLOCK_MAX_DEVIATION;
    const semitones = this.transpose - (locked ? 12 * Math.log2(speed) : 0);
    if (this.stretch && semitones !== this.semitones) this.stretch.schedule({ semitones });
    this.semitones = semitones;
    const stretched = !!this.stretch && (this.keylocked || this.transpose !== 0);
    if (stretched === this.stretched) return;
    this.stretched = stretched;
    this.tell({ type: 'latency', seconds: this.delay });
    const now = this.engine.ctx.currentTime;
    this.dry.gain.setTargetAtTime(stretched ? 0 : 1, now, 0.003);
    this.wet.gain.setTargetAtTime(stretched ? 1 : 0, now, 0.003);
  }

  setKeylock(on) {
    this.keylock = on;
    this.retune();
  }

  /**
   * Transposition in semitones, -12..12. With `toneplay`, keylock is forced until the transposition
   * changes by another command; the KEYLOCK setting itself is left as is.
   */
  setTranspose(semitones, { toneplay = false } = {}) {
    this.transpose = Math.max(-12, Math.min(12, Math.round(semitones)));
    this.toneplay = toneplay;
    this.retune();
  }

  /** Keylock in effect: KEYLOCK on, or forced by a toneplay pad. */
  get keylocked() {
    return this.keylock || this.toneplay;
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
    if (msg.type === 'wheel-stopped') {
      // Sent once, so even when a command made it stale: the playback stands still, and a SHIFT
      // search ends once the wheel is released.
      if (!this.scratch) return;
      this.scratch.v = 0;
      if (msg.gen === this.gen) this.report = { position: msg.position, time: msg.time };
      else this.rebase();
      if (!this.touched) this.stopScratch();
      return;
    }
    if (msg.gen !== this.gen || !this.running) return;
    if (this.ghost && msg.ghost !== null) this.ghost = { ...this.ghost, position: msg.ghost, time: msg.time };
    if (msg.type === 'ended') {
      this.playing = false;
      this.offset = msg.position;
      if (this.scratch) {
        this.scratch = null;
        this.updateSync();
        this.send({ type: 'speed', speed: this.speed });
        this.releaseSlip('scratch');
      }
    } else {
      this.report = { position: msg.position, time: msg.time };
      if (this.scratch && msg.speed !== this.scratch.v) {
        this.scratch.v = msg.speed;
        this.retune(); // keylock follows the speed of the wheel
      }
    }
  }

  get speed() {
    return this.scratch ? this.scratch.v : this.rate + this.bend;
  }

  /** Read position of the player, extrapolated from the last worklet report while playing. */
  get playhead() {
    if (!this.running) return this.offset;
    let p = this.report.position + (this.engine.ctx.currentTime - this.report.time) * this.speed;
    // The worklet goes back to the loop start at its end (worklets/deck-player.js, wrapLoop()).
    if (this.loop && this.speed > 0 && p >= this.loop.end) p = this.loop.start + ((p - this.loop.start) % (this.loop.end - this.loop.start));
    return Math.min(Math.max(0, p), this.duration);
  }

  /** Position heard: the playhead, minus what the stretch node still holds. */
  get position() {
    if (!this.running || !this.delay) return this.playhead;
    const playhead = this.playhead;
    let p = playhead - this.delay * this.speed;
    // Playhead just back at the loop start: the audio heard is still the end of the previous pass.
    const loop = this.loop;
    if (loop && this.speed > 0 && p < loop.start && playhead >= loop.start) p += loop.end - loop.start;
    return Math.min(Math.max(0, p), this.duration);
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
    this.retimeGhost();
  }

  stop() {
    if (!this.playing) return;
    this.offset = this.playhead;
    this.playing = false;
    if (!this.scratch) this.send({ type: 'stop', position: this.offset });
    this.retimeGhost();
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

  /** Seconds per beat of the beat grid, null without one. */
  get beatLength() {
    return this.grid?.bpm ? 60 / this.grid.bpm : null;
  }

  /** Loop length bounds (s): 1/32 to 64 beats with a grid, else the shortest loop to the track length. */
  loopBounds() {
    const beat = this.beatLength;
    return beat ? [beat * LOOP_MIN_BEATS, beat * LOOP_MAX_BEATS] : [LOOP_MIN_SECONDS, this.duration];
  }

  setLoop(loop) {
    const was = this.loop;
    this.loop = loop;
    this.send(loop ? { type: 'loop', start: loop.start, end: loop.end } : { type: 'loop', start: null });
    if (loop && !was) this.holdSlip('loop');
    else if (!loop && was) this.releaseSlip('loop');
  }

  /** SLIP on or off; switched off, a held ghost position is dropped where playback is. */
  setSlip(on) {
    this.slip = on;
    if (on || !this.slipHolds.size) return;
    if (this.slipHolds.has('roll')) { // a roll forces slip: its ghost stays
      this.slipHolds = new Set(['roll']);
      return;
    }
    this.slipHolds.clear();
    this.ghost = null;
    this.send({ type: 'ghost', speed: null });
  }

  /** Speed of the ghost position: the pitch fader's while the deck plays, still otherwise. */
  get ghostSpeed() {
    return this.playing ? this.rate : 0;
  }

  /** Ghost position (s) while slip holds one, extrapolated from the last worklet report; else null. */
  get slipPosition() {
    const g = this.ghost;
    if (!g) return null;
    return Math.min(Math.max(0, g.position + (this.engine.ctx.currentTime - g.time) * g.speed), this.duration);
  }

  /** With SLIP on (or `force`), `reason` (scratch, loop, hotcue, roll) starts holding the ghost position at the playhead. */
  holdSlip(reason, { force = false } = {}) {
    if (!(this.slip || force) || !this.buffer || this.slipHolds.has(reason)) return;
    if (!this.slipHolds.size) {
      this.ghost = { position: this.playhead, time: this.engine.ctx.currentTime, speed: this.ghostSpeed };
      this.send({ type: 'ghost', speed: this.ghostSpeed });
    }
    this.slipHolds.add(reason);
  }

  /** `reason` lets go; the last one sends playback back to the ghost position. */
  releaseSlip(reason) {
    if (!this.slipHolds.delete(reason) || this.slipHolds.size) return;
    const position = this.slipPosition;
    this.ghost = null;
    if (this.running) this.report = { position, time: this.engine.ctx.currentTime };
    else this.offset = position;
    this.send({ type: 'ghost', speed: null, jump: true });
  }

  /** The deck started, stopped or changed pitch: the ghost goes on at the new speed. */
  retimeGhost() {
    if (!this.ghost) return;
    this.ghost = { position: this.slipPosition, time: this.engine.ctx.currentTime, speed: this.ghostSpeed };
    this.send({ type: 'ghost', speed: this.ghostSpeed });
  }

  /** LOOP IN: sets the loop start (moves it when a loop is active). */
  loopIn() {
    if (!this.buffer) return;
    const position = this.position;
    this.loopStart = position;
    if (this.loop && position < this.loop.end - LOOP_MIN_SECONDS) this.setLoop({ start: position, end: this.loop.end });
  }

  /** LOOP OUT: sets the loop end and activates the loop; on an active loop, leaves it (playback goes on). */
  loopOut() {
    if (!this.buffer) return;
    if (this.loop) return this.exitLoop();
    const position = this.position;
    if (this.loopStart === null || position - this.loopStart < LOOP_MIN_SECONDS) return;
    this.setLoop({ start: this.loopStart, end: position });
  }

  /** Halves (0.5) or doubles (2) the active loop from its start, within loopBounds(). */
  scaleLoop(factor) {
    if (!this.loop) return;
    const length = (this.loop.end - this.loop.start) * factor;
    const [min, max] = this.loopBounds();
    const eps = 1e-9;
    if (length < min - eps || length > max + eps || this.loop.start + length > this.duration) return;
    this.setLoop({ start: this.loop.start, end: this.loop.start + length });
  }

  /** Loop of `beats` beats from the current beat (quantize) or the current position; needs a beat grid. */
  autoLoop(beats) {
    const beat = this.beatLength;
    if (!this.buffer || !beat) return;
    let start = this.position;
    if (this.quantize) start = this.grid.firstBeat + Math.floor((start - this.grid.firstBeat) / beat + 1e-6) * beat;
    start = Math.max(0, start);
    const end = Math.min(this.duration, start + beats * beat);
    this.loopStart = start;
    this.setLoop({ start, end });
  }

  /**
   * Auto loop button (Mixxx beatloop_X_toggle): leaves the active loop when it is `beats` beats long,
   * else sets an auto loop of `beats` beats.
   */
  toggleAutoLoop(beats) {
    const beat = this.beatLength;
    if (this.loop && beat && Math.abs(this.loop.end - this.loop.start - beats * beat) < 1e-6) return this.exitLoop();
    this.autoLoop(beats);
  }

  /** RELOOP while looping: leaves the loop, playback goes on from where it is (or the ghost position with slip). */
  exitLoop() {
    if (this.loop) this.setLoop(null);
  }

  /**
   * Loop roll of `beats` beats while a pad is held (needs a beat grid): slip is forced, so ending the
   * roll sends playback back to where it would have been. Another length while rolling replaces the loop.
   */
  startRoll(beats) {
    if (!this.buffer || !this.beatLength) return false;
    this.holdSlip('roll', { force: true });
    this.roll = beats;
    this.autoLoop(beats);
    return true;
  }

  /** The roll pad is released: the loop ends and playback goes back to the ghost position. */
  endRoll() {
    if (this.roll === null) return;
    this.roll = null;
    this.setLoop(null);
    this.releaseSlip('roll');
  }

  /** Moves playback by `beats` beats (negative: backwards), playing or stopped; needs a beat grid. */
  beatJump(beats) {
    const beat = this.beatLength;
    if (!this.buffer || !beat) return false;
    this.seek(this.playhead + beats * beat);
    return true;
  }

  applySpeed() {
    if (this.running) this.rebase();
    this.send({ type: 'speed', speed: this.speed });
  }

  /** Pitch fader -1..1 -> ±rateRange; ignored on a sync follower until it takes over (sync.js). */
  setRate(v) {
    const held = this.engine.sync.holdsFader(this, v);
    this.pitch = v;
    if (held) return;
    this.rate = 1 + v * this.rateRange;
    this.applySpeed();
    this.retimeGhost();
    this.fx.retime();
    this.engine.sync.tempoChanged(this);
  }

  /** Next pitch fader range (8, 16, 50 %); the fader keeps its position, so the tempo changes (as in Mixxx). */
  cycleRateRange() {
    this.rateRange = RATE_RANGES.find((r) => r > this.rateRange + 1e-6) ?? RATE_RANGES[0];
    if (this.engine.sync.follower !== this.index) this.setRate(this.pitch);
  }

  /** Track BPM and first beat (bpm null when unknown); tempo-synced effects and the sync follow it. */
  setBpm(bpm, firstBeat = 0) {
    this.bpm = bpm;
    this.firstBeat = firstBeat;
    this.tell({ type: 'grid', bpm, firstBeat });
    this.fx.retime();
    this.engine.sync.tempoChanged(this);
  }

  /** Deck whose phase this one follows (null: none); suspended while the wheel scratches. */
  setSyncMaster(master) {
    this.syncMaster = master;
    this.updateSync();
  }

  updateSync() {
    this.tell({ type: 'sync', master: this.scratch ? null : this.syncMaster });
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
    this.startScratch({ slip: false });
    this.scratchTicks(ticks * SEEK_MULTIPLIER);
  }

  setVinyl(on) {
    this.vinyl = on;
    if (!on && this.scratch) this.stopScratch();
  }

  /**
   * The wheel drives playback: the worklet turns ticks into a speed with the alpha-beta filter of
   * Mixxx, on the audio clock (#73), and reports that speed back.
   */
  startScratch({ slip = true } = {}) {
    if (!this.buffer || this.scratch) return;
    this.rebase();
    if (!this.playing) {
      this.report = { position: this.offset, time: this.engine.ctx.currentTime };
      this.send({ type: 'play' });
    }
    this.scratch = { v: 0 };
    this.send({ type: 'scratch', on: true });
    this.updateSync();
    this.retune();
    if (slip) this.holdSlip('scratch'); // a SHIFT search moves on, it does not slip
  }

  scratchTicks(ticks) {
    if (this.scratch) this.tell({ type: 'ticks', seconds: ticks * TICK_SECONDS });
  }

  /** Back to the pitch fader speed if the deck was playing, else stop where the wheel left it. */
  stopScratch() {
    if (!this.scratch) return;
    this.rebase();
    this.send({ type: 'scratch', on: false });
    this.scratch = null;
    this.updateSync();
    if (this.playing) {
      this.applySpeed();
    } else {
      this.offset = this.report.position;
      this.send({ type: 'stop', position: this.offset });
      this.send({ type: 'speed', speed: this.speed });
    }
    this.releaseSlip('scratch');
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
}
