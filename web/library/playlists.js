// Playlists: ordered lists of track ids (library/scan.js), a track may appear more than once.
// Pure helpers shared by the playlist panel (ui/playlists.js); nothing here touches the DOM.
import { parseName } from './scan.js';

/** Relative path of a track id `<path>|<size>|<lastModified>` (the path may contain "|"). */
export const idPath = (id) => id.split('|').slice(0, -2).join('|');

/** "Artist - Title" (or "Title") of a track id, from its file name. */
export function idLabel(id) {
  const { artist, title } = parseName(idPath(id).split('/').at(-1));
  return artist ? `${artist} - ${title}` : title;
}

/** Copy of `items` with `ids` inserted at index `at` (clamped; end when omitted). */
export function insert(items, ids, at = items.length) {
  const i = Math.max(0, Math.min(items.length, at));
  return [...items.slice(0, i), ...ids, ...items.slice(i)];
}

/** Copy of `items` with the entry at `from` moved before the entry that was at `to` (end if past it). */
export function move(items, from, to) {
  if (from < 0 || from >= items.length) return items.slice();
  const rest = items.filter((_, i) => i !== from);
  return insert(rest, [items[from]], to > from ? to - 1 : to);
}

/** Copy of `items` without the entry at `index`. */
export const removeAt = (items, index) => items.filter((_, i) => i !== index);

/**
 * Extended M3U text of `items`: one entry per item, paths relative to the music directory with "/"
 * separators, so the file works once saved next to the directory's root.
 */
export function toM3u8(items) {
  const lines = ['#EXTM3U'];
  for (const id of items) lines.push(`#EXTINF:-1,${idLabel(id)}`, idPath(id));
  return `${lines.join('\n')}\n`;
}

/** File name of the export of a playlist called `name`. */
export const m3u8Name = (name) => `${name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'playlist'}.m3u8`;
