// Deck effects built from native Web Audio nodes. Each factory takes (ctx, tempo), where tempo()
// returns the deck BPM or null, and returns { input, output, setParam(v), retime?() } with v the
// main parameter in 0..1 and retime() for tempo-synced effects. An effect output carries the
// processed signal; the unit (unit.js) mixes it with the dry signal.

const BEATS = [1 / 4, 1 / 2, 1, 2];
const DEFAULT_BEAT_S = 0.5; // one beat without a BPM
const MAX_DELAY_S = 4;
const SMOOTH_S = 0.01;

/** Glides an AudioParam to `value` (no zipper noise, no click). */
export function glide(param, value, ctx) {
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, SMOOTH_S);
}

/** Echo length in beats for the main parameter: 1/4, 1/2, 1 or 2 beats. */
export function echoBeats(v) {
  return BEATS[Math.round(Math.min(1, Math.max(0, v)) * (BEATS.length - 1))];
}

/** Echo: the input plus repeats every `beats` beats, decaying. */
function echo(ctx, tempo) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const delay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY_S });
  const feedback = new GainNode(ctx, { gain: 0.45 });
  const level = new GainNode(ctx, { gain: 0.7 });
  input.connect(output);
  input.connect(delay).connect(level).connect(output);
  delay.connect(feedback).connect(delay);
  let param = 0.5;
  const apply = () => {
    const beat = tempo() ? 60 / tempo() : DEFAULT_BEAT_S;
    glide(delay.delayTime, Math.min(MAX_DELAY_S, echoBeats(param) * beat), ctx);
  };
  return {
    input,
    output,
    setParam(v) {
      param = v;
      apply();
    },
    retime: apply,
  };
}

/** Reverb: a ConvolverNode on a generated impulse response (stereo noise, exponential decay). */
function reverb(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const seconds = 2.5;
  const ir = ctx.createBuffer(2, Math.round(seconds * ctx.sampleRate), ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp((-4 * i) / data.length * seconds);
  }
  const convolver = new ConvolverNode(ctx, { buffer: ir });
  const level = new GainNode(ctx, { gain: 0 });
  input.connect(output);
  input.connect(convolver).connect(level).connect(output);
  return { input, output, setParam: (v) => glide(level.gain, v, ctx) };
}

/** Flanger: the input plus a copy through a short delay swept by a slow LFO, with feedback. */
function flanger(ctx) {
  const input = ctx.createGain();
  const output = new GainNode(ctx, { gain: 0.7 });
  const delay = new DelayNode(ctx, { maxDelayTime: 0.02, delayTime: 0.004 });
  const feedback = new GainNode(ctx, { gain: 0.6 });
  const lfo = new OscillatorNode(ctx, { frequency: 0.25 });
  const depth = new GainNode(ctx, { gain: 0 });
  lfo.connect(depth).connect(delay.delayTime);
  lfo.start();
  input.connect(output);
  input.connect(delay).connect(output);
  delay.connect(feedback).connect(delay);
  return { input, output, setParam: (v) => glide(depth.gain, v * 0.0035, ctx) };
}

/** Resonant filter: lowpass below the centre, highpass above, open in the middle. */
function filter(ctx) {
  const node = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: ctx.sampleRate / 2, Q: 8 });
  return {
    input: node,
    output: node,
    setParam(v) {
      const nyquist = ctx.sampleRate / 2;
      if (Math.abs(v - 0.5) < 0.02) {
        node.type = 'lowpass';
        glide(node.frequency, nyquist, ctx);
      } else if (v < 0.5) {
        node.type = 'lowpass';
        glide(node.frequency, 40 * Math.pow(nyquist / 40, v / 0.5), ctx);
      } else {
        node.type = 'highpass';
        glide(node.frequency, 20 * Math.pow(10000 / 20, (v - 0.5) / 0.5), ctx);
      }
    },
  };
}

/** Bitcrusher: amplitude quantised by a WaveShaperNode, from 16 bits (v = 0) down to 2 bits (v = 1). */
function bitcrusher(ctx) {
  const node = new WaveShaperNode(ctx, { oversample: 'none' });
  const POINTS = 65537;
  return {
    input: node,
    output: node,
    setParam(v) {
      const steps = Math.pow(2, Math.round(16 - v * 14) - 1);
      const curve = new Float32Array(POINTS);
      for (let i = 0; i < POINTS; i++) curve[i] = Math.round(((i / (POINTS - 1)) * 2 - 1) * steps) / steps;
      node.curve = curve;
    },
  };
}

export const EFFECTS = {
  echo: { label: 'Écho', create: echo },
  reverb: { label: 'Réverbe', create: reverb },
  flanger: { label: 'Flanger', create: flanger },
  filter: { label: 'Filtre', create: filter },
  bitcrusher: { label: 'Bitcrusher', create: bitcrusher },
};
