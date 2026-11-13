// Track list of a music directory: works on any FileSystemDirectoryHandle (picked by the user, or
// the origin private file system in tests).

export const EXTENSIONS = ['mp3', 'flac', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'ogg', 'opus'];

const extension = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** True for a file name with one of EXTENSIONS, whatever its case. */
export const isAudio = (name) => EXTENSIONS.includes(extension(name));

/** "Artist - Title.mp3" -> { artist, title }, split on the first " - "; else artist is empty. */
export function parseName(name) {
  const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const i = base.indexOf(' - ');
  return i < 0 ? { artist: '', title: base } : { artist: base.slice(0, i), title: base.slice(i + 3) };
}

/** Key of every per-track datum (analysis, hotcues…): `<relative path>|<size>|<lastModified>`. */
export const trackId = (path, file) => `${path}|${file.size}|${file.lastModified}`;

/**
 * Walks `dir` recursively and returns its audio files sorted by relative path (French collation):
 * [{ id, path, artist, title, file }].
 */
export async function scanDirectory(dir) {
  const tracks = [];
  async function walk(handle, prefix) {
    for await (const entry of handle.values()) {
      const path = `${prefix}${entry.name}`;
      if (entry.kind === 'directory') {
        await walk(entry, `${path}/`);
      } else if (isAudio(entry.name)) {
        const file = await entry.getFile();
        tracks.push({ id: trackId(path, file), path, ...parseName(entry.name), file });
      }
    }
  }
  await walk(dir, '');
  return tracks.sort((a, b) => a.path.localeCompare(b.path, 'fr'));
}
