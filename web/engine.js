// Audio engine: two decks, a mixer and a 4-channel output.
// Channels 1-2 (indexes 0-1) carry MAIN, channels 3-4 (indexes 2-3) carry the headphone cue,
// matching the Inpulse 300 MK2 sound card (see README.md, "Matériel").

const EQ_CUT_DB = -26;
const EQ_BOOST_DB = 6;

/** Knob 0..1 with a centre detent at 0.5 -> dB (kill at 0, +6 dB at 1). */
export function knobToDb(v) {
  return v < 0.5 ? EQ_CUT_DB * (1 - v / 0.5) : EQ_BOOST_DB * ((v - 0.5) / 0.5);
}

export class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.cue = this.ctx.createGain();
    this.merger = this.ctx.createChannelMerger(4);
    const masterSplit = this.ctx.createChannelSplitter(2);
    const cueSplit = this.ctx.createChannelSplitter(2);
    this.master.connect(masterSplit);
    this.cue.connect(cueSplit);
    masterSplit.connect(this.merger, 0, 0);
    masterSplit.connect(this.merger, 1, 1);
    cueSplit.connect(this.merger, 0, 2);
    cueSplit.connect(this.merger, 1, 3);
    this.merger.connect(this.ctx.destination);
    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.crossfader = 0.5;
    this.configureOutput();
  }

  /** Uses 4 discrete channels when the device allows it, else stereo (MAIN only). */
  configureOutput() {
    const dest = this.ctx.destination;
    this.fourChannels = dest.maxChannelCount >= 4;
    dest.channelCount = this.fourChannels ? 4 : 2;
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    return this.fourChannels;
  }

  async setOutputDevice(deviceId) {
    if (!this.ctx.setSinkId) throw new Error('AudioContext.setSinkId non supporté (Chrome 110+)');
    await this.ctx.setSinkId(deviceId);
    return this.configureOutput();
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
    this.source = null;
    this.playing = false;
    this.offset = 0; // track position (s) at `anchor`
    this.anchor = 0; // ctx.currentTime of the last rebase
    this.rate = 1; // pitch fader
    this.bend = 0; // temporary nudge from the jog wheel
    this.cuePoint = 0;
    this.rateRange = 0.08;

    this.trim = ctx.createGain();
    this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 250 });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.7 });
    this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 4000 });
    this.filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: ctx.sampleRate / 2 });
    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();
    this.pfl = ctx.createGain();
    this.pfl.gain.value = 0;
    this.trim.connect(this.low).connect(this.mid).connect(this.high).connect(this.filter);
    this.filter.connect(this.fader).connect(this.xfade).connect(engine.master);
    this.filter.connect(this.pfl).connect(engine.cue); // pre-fader listen
  }

  async load(file) {
    this.stop();
    this.buffer = await this.engine.ctx.decodeAudioData(await file.arrayBuffer());
    this.name = file.name;
    this.offset = 0;
    this.cuePoint = 0;
  }

  get speed() {
    return this.rate + this.bend;
  }

  get position() {
    if (!this.playing) return this.offset;
    return this.offset + (this.engine.ctx.currentTime - this.anchor) * this.speed;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  rebase() {
    this.offset = this.position;
    this.anchor = this.engine.ctx.currentTime;
  }

  play() {
    if (!this.buffer || this.playing) return;
    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.speed;
    src.connect(this.trim);
    src.onended = () => {
      if (this.source === src) {
        this.rebase();
        this.playing = false;
        this.source = null;
      }
    };
    src.start(0, Math.max(0, this.offset));
    this.source = src;
    this.anchor = this.engine.ctx.currentTime;
    this.playing = true;
  }

  stop() {
    if (!this.playing) return;
    this.rebase();
    this.playing = false;
    const src = this.source;
    this.source = null;
    src.stop();
  }

  toggle() {
    this.playing ? this.stop() : this.play();
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    this.stop();
    this.offset = Math.min(Math.max(0, seconds), this.duration);
    if (wasPlaying) this.play();
  }

  /** CDJ-style cue: when stopped, set the cue point; when playing, jump back to it and stop. */
  cuePress() {
    if (this.playing) {
      this.stop();
      this.offset = this.cuePoint;
    } else {
      this.cuePoint = this.offset;
    }
  }

  applySpeed() {
    if (this.playing) this.rebase();
    if (this.source) this.source.playbackRate.value = this.speed;
  }

  /** Pitch fader -1..1 -> ±rateRange. */
  setRate(v) {
    this.rate = 1 + v * this.rateRange;
    this.applySpeed();
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
      this.seek(this.position + ticks * 0.02);
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
