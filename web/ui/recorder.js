// Mix recording: the REC button records the MAIN (after the limiter) to WebM Opus at 256 kb/s with
// MediaRecorder; a second press stops and offers the file for download.
const $ = (sel) => document.querySelector(sel);

export const RECORDING_TYPE = 'audio/webm;codecs=opus';
export const RECORDING_BITRATE = 256000;
const CHUNK_MS = 1000; // MediaRecorder hands over a chunk every second, not one buffer at the end

const pad = (n) => String(n).padStart(2, '0');

/** `mix-YYYY-MM-DD-HHMM.webm`, local time of `date`. */
export function recordingName(date) {
  return `mix-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.webm`;
}

/** `M:SS`, or `H:MM:SS` past one hour. */
function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function createRecorder(ctx) {
  const button = $('#rec');
  const time = $('#recTime');
  const link = $('#recFile');
  let stream = null; // MediaStreamAudioDestinationNode fed by the MAIN, created on the first REC
  let recorder = null;
  let started = 0;
  let timer = 0;

  // The clock is computed from the start time: right even when a hidden tab slows the timers down.
  const tick = () => { time.textContent = elapsed(Date.now() - started); };

  function start() {
    const { engine } = ctx;
    if (!engine) { ctx.log('Démarrer l\'audio avant d\'enregistrer.'); return; }
    if (!stream) {
      stream = engine.ctx.createMediaStreamDestination();
      engine.main.connect(stream);
    }
    const chunks = [];
    const date = new Date();
    const name = recordingName(date);
    recorder = new MediaRecorder(stream.stream, { mimeType: RECORDING_TYPE, audioBitsPerSecond: RECORDING_BITRATE });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: RECORDING_TYPE });
      if (link.href) URL.revokeObjectURL(link.href);
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.textContent = name;
      link.hidden = false;
      link.click();
      ctx.log(`Enregistrement arrêté : ${name} (${(blob.size / 1e6).toFixed(1)} Mo)`);
    };
    recorder.start(CHUNK_MS);
    started = date.getTime();
    tick();
    timer = setInterval(tick, 500);
    button.classList.add('rec');
    button.textContent = 'STOP';
    time.hidden = false;
    ctx.log(`Enregistrement du MAIN : ${name}`);
  }

  function stop() {
    clearInterval(timer);
    tick();
    recorder.stop();
    recorder = null;
    button.classList.remove('rec');
    button.textContent = 'REC';
  }

  button.addEventListener('click', () => (recorder ? stop() : start()));
  return { recording: () => recorder !== null };
}
