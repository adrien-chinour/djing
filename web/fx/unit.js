// Effect unit of a deck: three slots in series and a dry/wet mix.
//   input -> dry (1 - mix) -> output
//   input -> slot 1 -> slot 2 -> slot 3 -> wet (mix) -> output
// A slot passes its input through untouched while off (bypass gain 1, effect send 0); turning it on
// swaps the two gains. Effects keep running while off, so turning one on does not click.

import { EFFECTS, glide } from './effects.js';

export const SLOTS = 3;
export const DEFAULT_EFFECTS = ['echo', 'filter', 'reverb'];

class Slot {
  constructor(unit, type) {
    const ctx = unit.ctx;
    this.unit = unit;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.bypass = new GainNode(ctx, { gain: 1 });
    this.send = new GainNode(ctx, { gain: 0 });
    this.input.connect(this.bypass).connect(this.output);
    this.send.connect(this.output);
    this.on = false;
    this.param = 0.5;
    this.setEffect(type);
  }

  setEffect(type) {
    if (!EFFECTS[type]) throw new Error(`unknown effect ${type}`);
    if (this.effect) {
      this.input.disconnect(this.effect.input);
      this.effect.output.disconnect();
    }
    this.type = type;
    this.effect = EFFECTS[type].create(this.unit.ctx, this.unit.tempo);
    this.input.connect(this.effect.input);
    this.effect.output.connect(this.send);
    this.effect.setParam(this.param);
  }

  setOn(on) {
    this.on = on;
    glide(this.bypass.gain, on ? 0 : 1, this.unit.ctx);
    glide(this.send.gain, on ? 1 : 0, this.unit.ctx);
  }

  setParam(v) {
    this.param = v;
    this.effect.setParam(v);
  }
}

export class FxUnit {
  /** `tempo()` returns the current BPM of the deck, or null when unknown. */
  constructor(ctx, { tempo = () => null } = {}) {
    this.ctx = ctx;
    this.tempo = tempo;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = new GainNode(ctx, { gain: 0 });
    this.wet = new GainNode(ctx, { gain: 1 });
    this.mix = 1;
    this.enabled = true;
    this.slots = DEFAULT_EFFECTS.map((type) => new Slot(this, type));
    this.input.connect(this.dry).connect(this.output);
    const last = this.slots.reduce((prev, slot) => (prev.connect(slot.input), slot.output), this.input);
    last.connect(this.wet).connect(this.output);
  }

  /** Dry/wet, 0 (dry only) .. 1 (wet only). */
  setMix(v) {
    this.mix = v;
    this.applyMix();
  }

  /** Applies the unit to its deck or not; a unit not applied passes the signal dry, whatever the mix. */
  setEnabled(on) {
    this.enabled = on;
    this.applyMix();
  }

  applyMix() {
    const wet = this.enabled ? this.mix : 0;
    glide(this.dry.gain, 1 - wet, this.ctx);
    glide(this.wet.gain, wet, this.ctx);
  }

  /** Recomputes tempo-synced parameters (the BPM or the pitch changed). */
  retime() {
    for (const slot of this.slots) slot.effect.retime?.();
  }
}
