// Action and LED registries. The controller (midi.js) and the on-screen controls both call
// dispatch(); features register their actions and declare their LEDs, which are recomputed after
// every action and reported to listeners only when they change.

const actions = new Map();
const leds = [];
const ledListeners = [];

/** Registers `fn(deck, value)` under `name` (deck is 0, 1 or null for the master section). */
export function register(name, fn) {
  actions.set(name, fn);
}

/** Runs the action `name`, then refreshes the LEDs. Returns false when nothing is registered. */
export function dispatch(name, deck, value) {
  const fn = actions.get(name);
  if (!fn) return false;
  fn(deck, value);
  refreshLeds();
  return true;
}

/** Declares the LED `name` of `deck`, lit while `state()` is truthy. */
export function led(name, deck, state) {
  leds.push({ name, deck, state, last: undefined });
}

/** Calls `fn(name, deck, on)` for every LED change. */
export function onLed(fn) {
  ledListeners.push(fn);
}

/** Recomputes every LED; `force` reports them all, changed or not (e.g. a controller just connected). */
export function refreshLeds({ force = false } = {}) {
  for (const l of leds) {
    const on = !!l.state();
    if (!force && on === l.last) continue;
    l.last = on;
    for (const fn of ledListeners) fn(l.name, l.deck, on);
  }
}
