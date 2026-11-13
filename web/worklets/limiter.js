// AudioWorklet module: stereo-linked lookahead peak limiter for the MAIN bus, ceiling -1 dBFS.
// For each input sample, the gain it needs is ceiling / peak. The applied gain is the moving
// average (over the lookahead) of the minimum needed gain over the lookahead + 1 last samples,
// with a release, applied to the input delayed by the lookahead: it is never above the gain any
// delayed sample needs, so the output never exceeds the ceiling. Posts the gain reduction (dB,
// worst over the period) about 30 times per second.

const CEILING = 10 ** (-1 / 20);
const LOOKAHEAD_S = 0.005;
const RELEASE_S = 0.1;
const REPORT_HZ = 30;

class Limiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.look = Math.max(1, Math.round(sampleRate * LOOKAHEAD_S));
    this.need = new Float32Array(this.look + 1).fill(1); // needed gain of the last look + 1 inputs
    this.hold = new Float32Array(this.look).fill(1); // window minima averaged into the gain
    this.sum = this.look;
    this.delay = [new Float32Array(this.look), new Float32Array(this.look)];
    this.i = 0;
    this.j = 0;
    this.gain = 1;
    this.release = Math.exp(-1 / (sampleRate * RELEASE_S));
    this.minGain = 1;
    this.frames = 0;
  }

  process(inputs, outputs) {
    const [inL, inR = inL] = inputs[0];
    const [outL, outR] = outputs[0];
    const { need, hold, delay, look } = this;
    for (let k = 0; k < outL.length; k++) {
      const l = inL ? inL[k] : 0;
      const r = inR ? inR[k] : 0;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      need[this.i] = peak > CEILING ? CEILING / peak : 1;
      this.i = (this.i + 1) % need.length;
      let h = 1;
      for (let n = 0; n < need.length; n++) if (need[n] < h) h = need[n];
      this.sum += h - hold[this.j];
      hold[this.j] = h;
      const target = this.sum / look;
      this.gain = target < this.gain ? target : target + (this.gain - target) * this.release;
      outL[k] = delay[0][this.j] * this.gain;
      if (outR) outR[k] = delay[1][this.j] * this.gain;
      delay[0][this.j] = l;
      delay[1][this.j] = r;
      this.j = (this.j + 1) % look;
      if (this.gain < this.minGain) this.minGain = this.gain;
    }
    this.frames += outL.length;
    if (this.frames >= sampleRate / REPORT_HZ) {
      this.port.postMessage(-20 * Math.log10(this.minGain));
      this.frames = 0;
      this.minGain = 1;
    }
    return true;
  }
}

registerProcessor('limiter', Limiter);
