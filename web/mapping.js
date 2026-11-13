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
const hotcuePads = (shift) => Array.from({ length: HOTCUES }, (_, n) =>
  ({ status: PAD, number: n + (shift ? 8 : 0), type: 'note', action: `${shift ? 'shift.' : ''}hotcue.${n}` }));

export const INPUTS = [
  { status: MASTER_CC, number: 0x00, type: 'cc', action: 'crossfader' },
  { status: MASTER_CC, number: 0x01, type: 'jog', action: 'browse' }, // browser encoder, relative

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
  { status: CC, number: 0x09, type: 'jog', action: 'jog' },
  { status: CC, number: 0x0a, type: 'jog', action: 'jogTouched' },

  // SHIFT held: the controller sends on its own channels.
  { status: MASTER_SHIFT_NOTE, number: 0x00, type: 'note', action: 'shift.browser' },
  { status: SHIFT_NOTE, number: 0x00, type: 'note', action: 'shift.fx' },
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
  loopIn: { status: NOTE, number: 0x09 }, // lit while a loop is active
  sync: { status: NOTE, number: 0x05 },
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
