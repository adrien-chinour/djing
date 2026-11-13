// Web MIDI binding for the Hercules DJControl Inpulse 300 MK2.
// MIDI numbers come from mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml.

const DECK_NOTE_STATUS = { 0x91: 0, 0x92: 1 }; // note on, deck A / B
const DECK_CC_STATUS = { 0xb1: 0, 0xb2: 1 }; // control change, deck A / B
const DECK_SHIFT_CC_STATUS = { 0xb4: 0, 0xb5: 1 }; // jog with SHIFT held

const NOTE = { play: 0x07, cue: 0x06, pfl: 0x0c, wheelTouch: 0x08 };
const CC = { volume: 0x00, filter: 0x01, low: 0x02, mid: 0x03, high: 0x04, gain: 0x05, rateMsb: 0x08, rateLsb: 0x28, jog: 0x09, jogTouched: 0x0a };

export const LED = { play: 0x07, cue: 0x06, pfl: 0x0c };

/**
 * Connects to the controller and forwards decoded events to `handlers`:
 * button(deck, name, pressed), knob(deck, name, value 0..1), crossfader(value 0..1),
 * rate(deck, value -1..1), jog(deck, ticks, touched), raw(bytes).
 * Returns { status, setLed(deck, name, on) }.
 */
export async function connectController(handlers) {
  if (!navigator.requestMIDIAccess) {
    return { status: 'Web MIDI indisponible (utiliser Chrome ou Edge)', setLed() {} };
  }
  const access = await navigator.requestMIDIAccess({ sysex: false });
  const isInpulse = (port) => /inpulse/i.test(port.name || '');
  let output = null;
  const rateMsb = [64, 64];

  const bind = () => {
    output = [...access.outputs.values()].find(isInpulse) || null;
    for (const input of access.inputs.values()) {
      input.onmidimessage = isInpulse(input) ? onMessage : null;
    }
    return [...access.inputs.values()].some(isInpulse);
  };

  function onMessage(event) {
    const [status, number, value] = event.data;
    handlers.raw?.(event.data);
    if (status === 0xb0 && number === 0x00) {
      handlers.crossfader?.(value / 127);
      return;
    }
    if (status in DECK_NOTE_STATUS) {
      const deck = DECK_NOTE_STATUS[status];
      const name = Object.keys(NOTE).find((k) => NOTE[k] === number);
      if (name) handlers.button?.(deck, name, value > 0);
      return;
    }
    if (status in DECK_CC_STATUS) {
      const deck = DECK_CC_STATUS[status];
      if (number === CC.rateMsb) {
        rateMsb[deck] = value;
        return; // the LSB follows and carries the full 14-bit value
      }
      if (number === CC.rateLsb) {
        const raw14 = (rateMsb[deck] << 7) | value;
        handlers.rate?.(deck, raw14 / 8191.5 - 1);
        return;
      }
      if (number === CC.jog || number === CC.jogTouched) {
        // The wheel sends 0x01 clockwise, 0x7F counter-clockwise (7-bit signed).
        handlers.jog?.(deck, value < 0x40 ? value : value - 128, number === CC.jogTouched);
        return;
      }
      const name = Object.keys(CC).find((k) => CC[k] === number);
      if (name) handlers.knob?.(deck, name, value / 127);
      return;
    }
    if (status in DECK_SHIFT_CC_STATUS && (number === CC.jog || number === CC.jogTouched)) {
      handlers.jog?.(DECK_SHIFT_CC_STATUS[status], (value < 0x40 ? value : value - 128) * 4, true);
    }
  }

  let found = bind();
  access.onstatechange = () => {
    found = bind();
    handlers.connection?.(found);
  };

  return {
    get status() {
      return found ? 'Platine connectée' : 'Platine non détectée (branchée ? Mixxx fermé ?)';
    },
    connected: () => found,
    setLed(deck, name, on) {
      output?.send([deck === 0 ? 0x91 : 0x92, LED[name], on ? 0x7f : 0x00]);
    },
  };
}
