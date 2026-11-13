// Deck player: reads one track at a signed speed on the audio thread.
// Messages in (all but `load` carry `gen`, echoed back so the deck can drop stale reports):
//   { type: 'load', channels: Float32Array[] }   track samples, at the context sample rate
//   { type: 'play' } | { type: 'stop', position } | { type: 'seek', position } | { type: 'speed', speed }
//   { type: 'loop', start, end }                  loop between start and end (s); start null: no loop
// Messages out:
//   { type: 'position', position, time, playing, gen }   at least 60 times per second
//   { type: 'ended', position, gen }                      end of track (or 0 in reverse)
// Positions are in seconds, `time` is the context time of the reported position.

const MAX_SPEED = 4;
const FADE_SECONDS = 0.005;
const REPORTS_PER_SECOND = 120;

class DeckPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];
    this.length = 0;
    this.pos = 0; // read position in frames
    this.speed = 1;
    this.playing = false;
    this.gen = 0;
    this.fadeFrames = Math.round(FADE_SECONDS * sampleRate);
    this.fadeLeft = 0; // frames left in the crossfade after a seek
    this.fadePos = 0; // read position of the outgoing audio during the crossfade
    this.loop = null; // { start, end } in frames while a loop is active
    this.reportEvery = Math.max(1, Math.floor(sampleRate / REPORTS_PER_SECOND / 128));
    this.blocks = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (msg.gen !== undefined) this.gen = msg.gen;
    switch (msg.type) {
      case 'load':
        this.channels = msg.channels;
        this.length = msg.channels[0]?.length ?? 0;
        this.pos = 0;
        this.playing = false;
        this.fadeLeft = 0;
        this.loop = null;
        break;
      case 'play':
        if (this.length) this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        this.fadeLeft = 0;
        this.pos = this.clampFrames(msg.position * sampleRate);
        break;
      case 'seek': {
        const target = this.clampFrames(msg.position * sampleRate);
        if (this.playing) {
          this.fadePos = this.pos;
          this.fadeLeft = this.fadeFrames;
        }
        this.pos = target;
        break;
      }
      case 'speed':
        this.speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, msg.speed));
        break;
      case 'loop':
        this.loop = msg.start === null ? null : { start: msg.start * sampleRate, end: msg.end * sampleRate };
        break;
    }
    this.report();
  }

  clampFrames(frames) {
    return Math.max(0, Math.min(this.length, frames || 0));
  }

  /** Linear interpolation of channel `c` at fractional frame `pos` (silence outside the track). */
  sample(c, pos) {
    const data = this.channels[Math.min(c, this.channels.length - 1)];
    const i = Math.floor(pos);
    if (i < 0 || i >= this.length) return 0;
    const a = data[i];
    const b = i + 1 < this.length ? data[i + 1] : a;
    return a + (b - a) * (pos - i);
  }

  /**
   * Back to the other end of the loop when the read position leaves it: by exactly the loop length
   * (the fractional part is kept), with the seek crossfade from the audio past the boundary.
   */
  wrapLoop() {
    const { start, end } = this.loop;
    const length = end - start;
    let pos = this.pos;
    if (this.speed > 0 && pos >= end) pos = start + ((pos - start) % length);
    else if (this.speed < 0 && pos < start && pos >= start + this.speed) pos += length; // crossed the start just now
    else return;
    this.fadePos = this.pos;
    this.fadeLeft = this.fadeFrames;
    this.pos = pos;
  }

  /**
   * Fills `out` (one Float32Array per output channel) from the track at the current speed and
   * returns false once the track boundary is reached. A time-stretch stage (#39) goes here, between
   * the read position and the output.
   */
  render(out) {
    const n = out[0].length;
    for (let f = 0; f < n; f++) {
      if (this.loop) this.wrapLoop();
      if (this.speed > 0 ? this.pos >= this.length : this.speed < 0 && this.pos <= 0) {
        this.pos = this.speed > 0 ? this.length : 0;
        for (const ch of out) ch.fill(0, f);
        return false;
      }
      let g = 1;
      if (this.fadeLeft > 0) g = 1 - this.fadeLeft / this.fadeFrames;
      for (let c = 0; c < out.length; c++) {
        let v = this.sample(c, this.pos) * g;
        if (g < 1) v += this.sample(c, this.fadePos) * (1 - g);
        out[c][f] = v;
      }
      if (this.fadeLeft > 0) {
        this.fadeLeft--;
        this.fadePos += this.speed;
      }
      this.pos += this.speed;
    }
    return true;
  }

  report(type = 'position') {
    this.port.postMessage({ type, position: this.pos / sampleRate, time: currentTime, playing: this.playing, gen: this.gen });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.playing) {
      for (const ch of out) ch.fill(0);
    } else {
      const reportAt = { position: this.pos, time: currentTime };
      if (!this.render(out)) {
        this.playing = false;
        this.fadeLeft = 0;
        this.report('ended');
        return true;
      }
      if (++this.blocks % this.reportEvery === 0) {
        this.port.postMessage({ type: 'position', position: reportAt.position / sampleRate, time: reportAt.time, playing: true, gen: this.gen });
      }
    }
    return true;
  }
}

registerProcessor('deck-player', DeckPlayer);
