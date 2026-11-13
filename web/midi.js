// Web MIDI binding for the Hercules DJControl Inpulse 300 MK2, driven by the tables of mapping.js.
import { INPUTS, LEDS } from './mapping.js';

const key = (status, number) => (status << 8) | number;

/**
 * Returns `decode(bytes)`: looks the message up in `inputs`, calls `dispatch(action, deck, value)`
 * with the value decoded by the entry's type, and returns the entry (null when unmapped).
 */
export function createDecoder(dispatch, inputs = INPUTS) {
  const index = new Map();
  for (const entry of inputs) {
    const perDeck = Array.isArray(entry.status);
    (perDeck ? entry.status : [entry.status]).forEach((status, i) => {
      const deck = perDeck ? i : null;
      index.set(key(status, entry.number), { entry, deck, lsb: false });
      if (entry.type === '14bit') index.set(key(status, entry.lsb), { entry, deck, lsb: true });
    });
  }
  const msb = new Map();

  return (bytes) => {
    const [status, number, value] = bytes;
    const hit = index.get(key(status, number));
    if (!hit) return null;
    const { entry, deck } = hit;
    if (entry.type === 'note' || entry.type === 'cc') {
      dispatch(entry.action, deck, value / 127);
    } else if (entry.type === 'jog') {
      dispatch(entry.action, deck, value < 0x40 ? value : value - 128);
    } else if (entry.type === '14bit') {
      if (!hit.lsb) {
        msb.set(status, value); // the LSB follows and carries the full 14-bit value
      } else {
        const raw14 = ((msb.get(status) ?? 64) << 7) | value;
        dispatch(entry.action, deck, raw14 / 8191.5 - 1);
      }
    }
    return entry;
  };
}

/**
 * Connects to the controller and sends every mapped message to `dispatch(action, deck, value)`.
 * Optional `hooks`: raw(bytes, entry) for every message, connection(found) on plug or unplug.
 * Returns { status, connected(), setLed(name, deck, on) }.
 */
export async function connectController(dispatch, hooks = {}) {
  if (!navigator.requestMIDIAccess) {
    return { status: 'Web MIDI indisponible (utiliser Chrome ou Edge)', connected: () => false, setLed() {} };
  }
  const access = await navigator.requestMIDIAccess({ sysex: false });
  const isInpulse = (port) => /inpulse/i.test(port.name || '');
  const decode = createDecoder(dispatch);
  let output = null;

  const onMessage = (event) => {
    const entry = decode(event.data);
    hooks.raw?.(event.data, entry);
  };

  const bind = () => {
    output = [...access.outputs.values()].find(isInpulse) || null;
    for (const input of access.inputs.values()) {
      input.onmidimessage = isInpulse(input) ? onMessage : null;
    }
    return [...access.inputs.values()].some(isInpulse);
  };

  let found = bind();
  access.onstatechange = () => {
    found = bind();
    hooks.connection?.(found);
  };

  return {
    get status() {
      return found ? 'Platine connectée' : 'Platine non détectée (branchée ? Mixxx fermé ?)';
    },
    connected: () => found,
    setLed(name, deck, on) {
      const address = LEDS[name];
      if (!address) return;
      const status = Array.isArray(address.status) ? address.status[deck] : address.status;
      output?.send([status, address.number, on ? 0x7f : 0x00]);
    },
  };
}
