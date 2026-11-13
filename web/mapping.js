// Declarative MIDI mapping of the Hercules DJControl Inpulse 300 MK2: every input the page reads
// and every LED it drives. Adding a control means adding a line here and registering its action.
// Numbers come from mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml; pad modes from
// /usr/share/mixxx/controllers/Hercules-DJControl-Inpulse-300-script.js (15 to 22).
//
// Input entry: { status, number, type, action }.
// - status: one byte for the master section (deck null), or [deck A, deck B].
// - type: note (value 0..1, 0 on release), cc (value 0..1), 14bit (`number` is the MSB, `lsb` the
//   LSB that carries the full value, value -1..1), jog (signed ticks, 0x01 clockwise, 0x7F counter).
// - action: name registered in actions.js; an unregistered action does nothing.

export const PAD_MODES = ['hotcue', 'roll', 'slicer', 'sampler', 'toneplay', 'fx', 'slicerloop', 'beatjump'];
export const DEFAULT_PAD_MODE = 'hotcue';
const PAD_MODE_FIRST = 0x0f;

const MASTER_CC = 0xb0;
const MASTER_NOTE = 0x90;
const NOTE = [0x91, 0x92];
const CC = [0xb1, 0xb2];
const MASTER_SHIFT_NOTE = 0x93;
const SHIFT_NOTE = [0x94, 0x95];
const SHIFT_CC = [0xb4, 0xb5];
const PAD = [0x96, 0x97]; // performance pads; hotcue page 0x00..0x07, +8 with SHIFT
export const HOTCUES = 8;
// Slicer pads: the controller sends 0x20..0x27 in slicer mode and 0x60..0x67 in slicer loop mode;
// both reach the same slicer.<n> action, as DJCi300.deck[n].slicerPad[n].input in Mixxx.
export const SLICES = 8;
const SLICER_FIRST = { slicer: 0x20, slicerloop: 0x60 };
const slicerPads = () => Object.values(SLICER_FIRST).flatMap((first) => Array.from({ length: SLICES }, (_, n) =>
  ({ status: PAD, number: first + n, type: 'note', action: `slicer.${n}` })));
// Roll page (0x10..0x17): loop roll lengths in beats; beatjump page (0x70..0x77): jumps in beats, in
// the order of the MIDI table (beatjump_1_backward, beatjump_1_forward, ...).
export const ROLL_BEATS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16];
export const BEATJUMP_BEATS = [-1, 1, -2, 2, -4, 4, -8, 8];
const ROLL_FIRST = 0x10;
const BEATJUMP_FIRST = 0x70;
// Toneplay page (0x40..0x47, +8 with SHIFT): transposition of each pad in semitones, as in
// DJCi300.toneplay of the Hercules script shipped with Mixxx.
export const TONEPLAY_SEMITONES = [0, 1, 2, 3, -4, -3, -2, -1];
const TONEPLAY_FIRST = 0x40;
const toneplayPads = (shift) => TONEPLAY_SEMITONES.map((_, n) =>
  ({ status: PAD, number: TONEPLAY_FIRST + n + (shift ? 8 : 0), type: 'note', action: `${shift ? 'shift.' : ''}toneplay.${n}` }));
// FX page (0x50..0x57, EffectRack1_EffectUnit<deck> in the MIDI table): slots 1..3 on/off, unit
// applied to the deck, next effect of slots 1..3. 0x57 (the other deck's unit) and the SHIFT page
// 0x58..0x5F (units 3 and 4) have no counterpart here: one unit per deck.
const FX_PAD_FIRST = 0x50;
const FX_PADS = ['fx.0.on', 'fx.1.on', 'fx.2.on', 'fx.unit', 'fx.0.next', 'fx.1.next', 'fx.2.next'];
const hotcuePads = (shift) => Array.from({ length: HOTCUES }, (_, n) =>
  ({ status: PAD, number: n + (shift ? 8 : 0), type: 'note', action: `${shift ? 'shift.' : ''}hotcue.${n}` }));

export const INPUTS = [
  { status: MASTER_CC, number: 0x00, type: 'cc', action: 'crossfader' },
  { status: MASTER_CC, number: 0x01, type: 'jog', action: 'browse' }, // browser encoder, relative
  { status: MASTER_NOTE, number: 0x03, type: 'note', action: 'autoDj' },

  { status: NOTE, number: 0x07, type: 'note', action: 'play' },
  { status: NOTE, number: 0x06, type: 'note', action: 'cue' },
  { status: NOTE, number: 0x0c, type: 'note', action: 'pfl' },
  { status: NOTE, number: 0x08, type: 'note', action: 'wheelTouch' },
  { status: NOTE, number: 0x0d, type: 'note', action: 'loadSelected' },
  { status: NOTE, number: 0x03, type: 'note', action: 'vinyl' },
  { status: NOTE, number: 0x02, type: 'note', action: 'quantize' },
  { status: NOTE, number: 0x01, type: 'note', action: 'slip' },
  ...hotcuePads(false),
  ...hotcuePads(true),
  ...slicerPads(),
  ...ROLL_BEATS.map((_, n) => ({ status: PAD, number: ROLL_FIRST + n, type: 'note', action: `roll.${n}` })),
  ...BEATJUMP_BEATS.map((_, n) => ({ status: PAD, number: BEATJUMP_FIRST + n, type: 'note', action: `beatjump.${n}` })),
  ...toneplayPads(false),
  ...toneplayPads(true),
  ...FX_PADS.map((action, n) => ({ status: PAD, number: FX_PAD_FIRST + n, type: 'note', action })),
  { status: NOTE, number: 0x00, type: 'note', action: 'fx.2.on' }, // FX button: slot 3
  { status: NOTE, number: 0x09, type: 'note', action: 'loopIn' },
  { status: NOTE, number: 0x0a, type: 'note', action: 'loopOut' },
  { status: NOTE, number: 0x05, type: 'note', action: 'sync' },
  ...PAD_MODES.map((mode, i) => ({ status: NOTE, number: PAD_MODE_FIRST + i, type: 'note', action: `padMode.${mode}` })),

  { status: CC, number: 0x00, type: 'cc', action: 'volume' },
  { status: CC, number: 0x01, type: 'cc', action: 'filter' },
  { status: CC, number: 0x02, type: 'cc', action: 'low' },
  { status: CC, number: 0x03, type: 'cc', action: 'mid' },
  { status: CC, number: 0x04, type: 'cc', action: 'high' },
  { status: CC, number: 0x05, type: 'cc', action: 'gain' },
  { status: CC, number: 0x08, lsb: 0x28, type: '14bit', action: 'pitchFader' },
  { status: CC, number: 0x06, type: 'cc', action: 'fx.2.param' }, // FX knob: slot 3 parameter (meta)
  { status: CC, number: 0x07, type: 'cc', action: 'fx.mix' }, // dry/wet of the unit
  { status: CC, number: 0x09, type: 'jog', action: 'jog' },
  { status: CC, number: 0x0a, type: 'jog', action: 'jogTouched' },

  // SHIFT held: the controller sends on its own channels.
  { status: MASTER_SHIFT_NOTE, number: 0x00, type: 'note', action: 'shift.browser' },
  { status: SHIFT_NOTE, number: 0x00, type: 'note', action: 'fx.2.next' }, // SHIFT + FX: next effect of slot 3
  { status: SHIFT_NOTE, number: 0x01, type: 'note', action: 'shift.slip' },
  { status: SHIFT_NOTE, number: 0x02, type: 'note', action: 'shift.quantize' },
  { status: SHIFT_NOTE, number: 0x05, type: 'note', action: 'shift.sync' },
  { status: SHIFT_NOTE, number: 0x06, type: 'note', action: 'shift.cue' },
  { status: SHIFT_NOTE, number: 0x07, type: 'note', action: 'shift.play' },
  { status: SHIFT_NOTE, number: 0x08, type: 'note', action: 'shift.wheelTouch' },
  { status: SHIFT_NOTE, number: 0x09, type: 'note', action: 'shift.loopIn' },
  { status: SHIFT_NOTE, number: 0x0a, type: 'note', action: 'shift.loopOut' },
  { status: SHIFT_CC, number: 0x09, type: 'jog', action: 'shift.jog' },
  { status: SHIFT_CC, number: 0x0a, type: 'jog', action: 'shift.jog' },
];

// LED name (as declared with led() in actions.js) -> MIDI address; on = 0x7F, off = 0x00.
export const LEDS = {
  play: { status: NOTE, number: 0x07 },
  cue: { status: NOTE, number: 0x06 },
  pfl: { status: NOTE, number: 0x0c },
  vinyl: { status: NOTE, number: 0x03 },
  quantize: { status: NOTE, number: 0x02 },
  slip: { status: NOTE, number: 0x01 },
  ...Object.fromEntries(Array.from({ length: HOTCUES }, (_, n) => [`hotcue.${n}`, { status: PAD, number: n }])),
  // slicer.<n> and slicerloop.<n>: pad n of each slicer page.
  ...Object.fromEntries(Object.entries(SLICER_FIRST).flatMap(([mode, first]) =>
    Array.from({ length: SLICES }, (_, n) => [`${mode}.${n}`, { status: PAD, number: first + n }]))),
  ...Object.fromEntries(ROLL_BEATS.map((_, n) => [`roll.${n}`, { status: PAD, number: ROLL_FIRST + n }])), // lit while rolling
  // toneplay.<n> and shift.toneplay.<n>: the pad of the current transposition, with and without SHIFT.
  ...Object.fromEntries(TONEPLAY_SEMITONES.flatMap((_, n) => [
    [`toneplay.${n}`, { status: PAD, number: TONEPLAY_FIRST + n }],
    [`shift.toneplay.${n}`, { status: PAD, number: TONEPLAY_FIRST + 8 + n }]])),
  loopIn: { status: NOTE, number: 0x09 }, // lit while a loop is active
  'fx.button': { status: NOTE, number: 0x00 }, // slot 3 on
  // fxPad.<n>: FX page pads 1..4 (slots 1..3 on, unit applied to the deck).
  ...Object.fromEntries(FX_PADS.slice(0, 4).map((_, n) => [`fxPad.${n}`, { status: PAD, number: FX_PAD_FIRST + n }])),
  sync: { status: NOTE, number: 0x05 },
  autoDj: { status: MASTER_NOTE, number: 0x03 },
  ...Object.fromEntries(PAD_MODES.map((mode, i) => [`padMode.${mode}`, { status: NOTE, number: PAD_MODE_FIRST + i }])),
};

// Meter name (as reported with meter() in actions.js) -> MIDI address; value 0..125, as sent by
// DJCi300.vuMeterUpdateDeck / vuMeterUpdateMain in the Hercules script shipped with Mixxx.
export const METERS = {
  vu: { status: CC, number: 0x40 }, // deck, pre-fader
  'vu.mainLeft': { status: MASTER_CC, number: 0x40 },
  'vu.mainRight': { status: MASTER_CC, number: 0x41 },
};
export const METER_MAX = 125;
