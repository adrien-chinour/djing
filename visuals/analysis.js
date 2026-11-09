// analysis.js — sound analysis shared by audio-server.js (Node, PipeWire capture)
// and start.html (browser, Web Audio capture). ES5 on purpose: it must run in
// both without a build step, and make check enforces ES5 on this folder.
//
//   var an = Analysis.create({ rate: 48000, minRefDb: -35, rangeDb: 20, riseDb: 8 }, onFeatures);
//   an.push(float32MonoSamples);   // any length; onFeatures fires every HOP samples
//
// Features (≈47 per second at 48 kHz, raw values — smoothing is the visual's job):
//   level  0-1  perceived loudness (full band, dB scale, bounded auto-gain)
//   low    0-1  40-120 Hz   (kick / sub)
//   mid    0-1  250-2000 Hz (voices, synths)
//   high   0-1  4-12 kHz    (hats, cymbals)
//   onset  0-1  strength of a kick (rise of the low band) on this hop, 0 otherwise
//   tone   0-1  spectral balance : 1 = bass-heavy (warm), 0 = treble-heavy (cold)
//   dbg    raw dB values, auto-gain references, low-band rise and threshold (for debug.html)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analysis = factory();
}(this, function () {
  'use strict';

  var FFTSIZE = 4096;    // ≈11.7 Hz per bin at 48 kHz → usable bass resolution
  var HOP     = 1024;    // new analysis every ≈21 ms → low latency despite large window
  var REF_RELEASE_DB_PER_S = 1.5;   // how fast the auto-gain reference comes down after a loud part
  var RISE_HOPS = 3;                // kick look-back, ≈64 ms
  var REFRACTORY_S = 0.15;
  // Scale so that a full-scale sine reads ≈ 0 dBFS (Hann coherent gain 0.5, single-sided ×2)
  var MAG_SCALE = 4 / FFTSIZE;
  var HANN_ENBW = 1.5;

  // ── FFT (radix-2, in place) with precomputed twiddles ───────────────────
  var twRe = new Float32Array(FFTSIZE / 2);
  var twIm = new Float32Array(FFTSIZE / 2);
  var hann = new Float32Array(FFTSIZE);
  var k;
  for (k = 0; k < FFTSIZE / 2; k++) {
    twRe[k] = Math.cos(-2 * Math.PI * k / FFTSIZE);
    twIm[k] = Math.sin(-2 * Math.PI * k / FFTSIZE);
  }
  for (k = 0; k < FFTSIZE; k++) hann[k] = 0.5 * (1 - Math.cos(2 * Math.PI * k / (FFTSIZE - 1)));

  function fft(re, im) {
    var n = re.length, i, j, bit, t, len, half, step, wr, wi, a, b, vr, vi;
    for (i = 1, j = 0; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (len = 2; len <= n; len <<= 1) {
      half = len >> 1; step = n / len;
      for (i = 0; i < n; i += len) {
        for (j = 0; j < half; j++) {
          wr = twRe[j * step]; wi = twIm[j * step];
          a = i + j; b = a + half;
          vr = re[b] * wr - im[b] * wi;
          vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr;        im[a] += vi;
        }
      }
    }
  }

  function r3(v) { return Math.round(v * 1000) / 1000; }
  function r1(v) { return Math.round(v * 10) / 10; }

  // opts: rate (Hz, required), minRefDb, rangeDb, riseDb. onFeatures(features) per hop.
  function create(opts, onFeatures) {
    var RATE = opts.rate;
    var MIN_REF_DB = opts.minRefDb, RANGE_DB = opts.rangeDb, RISE_DB = opts.riseDb;
    var HOP_S = HOP / RATE, BIN_HZ = RATE / FFTSIZE;

    function bins(loHz, hiHz) {
      return [Math.max(1, Math.round(loHz / BIN_HZ)), Math.min(FFTSIZE / 2 - 1, Math.round(hiHz / BIN_HZ))];
    }
    var BANDS = { full: bins(30, 16000), low: bins(40, 120), mid: bins(250, 2000), high: bins(4000, 12000) };

    var power = new Float32Array(FFTSIZE / 2);
    function bandDb(band) {
      var sum = 0, i;
      for (i = band[0]; i <= band[1]; i++) sum += power[i];
      return 10 * Math.log10(sum / HANN_ENBW + 1e-12);
    }

    // Bounded auto-gain, one per band: the reference follows the recent peak, never
    // drops below MIN_REF_DB; everything under (reference − RANGE_DB) maps to 0.
    var ref = { full: MIN_REF_DB, low: MIN_REF_DB, mid: MIN_REF_DB, high: MIN_REF_DB };
    function toLevel(name, db) {
      ref[name] = Math.max(MIN_REF_DB, ref[name] - REF_RELEASE_DB_PER_S * HOP_S, db);
      var floor = ref[name] - RANGE_DB;
      return Math.min(1, Math.max(0, (db - floor) / RANGE_DB));
    }

    // Kick detection: the 40-120 Hz level drops between kicks and jumps back on each
    // one; the jump is what we detect, so a regular pattern never becomes "normal".
    var lowHist = new Float32Array(RISE_HOPS), lowCount = 0, lastOnsetT = -1, t = 0, i0;
    for (i0 = 0; i0 < RISE_HOPS; i0++) lowHist[i0] = -120;
    function detectOnset(lowDb) {
      var prevMin = Infinity, i, rise, onset = 0, audible;
      for (i = 0; i < RISE_HOPS; i++) prevMin = Math.min(prevMin, lowHist[i]);
      lowHist[lowCount++ % RISE_HOPS] = lowDb;
      rise = lowDb - prevMin;
      // Gate on absolute level (silence floor), not on the auto-gained level.
      audible = lowDb > MIN_REF_DB - RANGE_DB;
      if (lowCount > RISE_HOPS && rise > RISE_DB && audible && (t - lastOnsetT) > REFRACTORY_S) {
        onset = Math.min(1, 0.4 + (rise - RISE_DB) / 16);
        lastOnsetT = t;
      }
      return { onset: onset, rise: rise };
    }

    var ring = new Float32Array(FFTSIZE);   // circular buffer of the last FFTSIZE mono samples
    var ringPos = 0, pendingHop = 0;
    var re = new Float32Array(FFTSIZE), im = new Float32Array(FFTSIZE);

    function analyse() {
      var i, m, db, level, low, mid, high, kick, sum, tone;
      for (i = 0; i < FFTSIZE; i++) {
        re[i] = ring[(ringPos + i) % FFTSIZE] * hann[i];   // oldest → newest
        im[i] = 0;
      }
      fft(re, im);
      for (i = 0; i < FFTSIZE / 2; i++) {
        m = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * MAG_SCALE;
        power[i] = m * m;
      }
      db = { full: bandDb(BANDS.full), low: bandDb(BANDS.low), mid: bandDb(BANDS.mid), high: bandDb(BANDS.high) };
      level = toLevel('full', db.full);
      low   = toLevel('low',  db.low);
      mid   = toLevel('mid',  db.mid);
      high  = toLevel('high', db.high);
      kick  = detectOnset(db.low);
      // Balance between bands, each already auto-gained → a track that is
      // naturally bass-heavy does not stay red forever. Neutral 0.5 when silent.
      sum  = low + mid + high;
      tone = sum > 0.05 ? (low * 1 + mid * 0.5) / sum : 0.5;
      t += HOP_S;
      onFeatures({
        level: r3(level), low: r3(low), mid: r3(mid), high: r3(high),
        onset: r3(kick.onset), tone: r3(tone),
        dbg: {
          db:  { full: r1(db.full), low: r1(db.low), mid: r1(db.mid), high: r1(db.high) },
          ref: { full: r1(ref.full), low: r1(ref.low), mid: r1(ref.mid), high: r1(ref.high) },
          rise: r1(kick.rise), thr: RISE_DB, range: RANGE_DB, minRef: MIN_REF_DB
        }
      });
    }

    // Feed mono samples in [-1, 1]; any array-like of numbers.
    function push(samples) {
      var i, n = samples.length;
      for (i = 0; i < n; i++) {
        ring[ringPos] = samples[i];
        ringPos = (ringPos + 1) % FFTSIZE;
        if (++pendingHop >= HOP) { pendingHop = 0; analyse(); }
      }
    }

    return { push: push, hopSeconds: HOP_S, hop: HOP, fftSize: FFTSIZE };
  }

  return { create: create, FFTSIZE: FFTSIZE, HOP: HOP };
}));
