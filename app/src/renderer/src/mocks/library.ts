// The web mock's library (contracts v1.1), for shooting the wheel: three sources, a few playlists and crates, made-up
// tracks, most with a two-tone gradient cover (a few without, for the plain card). Only with ?library in the URL; otherwise the library is empty ("Add your music").
import type { components } from '@/api/schema'

type Source = components['schemas']['LibrarySource']
type Playlist = components['schemas']['LibraryPlaylist']
type Track = components['schemas']['LibraryTrack']

export const mockLibraryOn = (): boolean => typeof location !== 'undefined' && new URLSearchParams(location.search).has('library')

const NAMES = [
  'Copper Line',
  'Static Bloom',
  'Low Orbit',
  'Paper Moon Dub',
  'Glass Hours',
  'Red Season',
  'Afterglow',
  'Kite Engine',
  'Northern Weight',
  'Velvet Static',
  'Sundown Circuit',
  'Hollow Pulse',
  'Ember Ritual',
  'Night Garden',
  'Signal Fire',
  'Slow Tide',
  'Iron Lantern',
  'Cold Bloom',
  'Neon Field',
  'Drift Mode',
  'Half Light',
  'Rust Choir',
  'Tall Grass',
  'Blue Hour',
]
// made up
const ARTISTS = ['Ruby Arc', 'Halden', 'Sorrel & Sage', 'Nova Pell', 'Kestrel Unit', 'Mira Quill', 'Low Lantern']
const KEYS = ['8A', '9A', '10A', '11B', '4A', '5A', '6B', '12A']
const SOURCES: Source[] = [
  { id: 'src-folder', kind: 'folder', name: 'Music folder', state: 'ready', tracks: 10, playlists: 2, created_at: '2026-10-01T00:00:00Z' },
  { id: 'src-rb', kind: 'rekordbox', name: 'Rekordbox', state: 'ready', tracks: 8, playlists: 3, created_at: '2026-10-01T00:00:00Z' },
  { id: 'src-serato', kind: 'serato', name: 'Serato', state: 'ready', tracks: 6, playlists: 2, created_at: '2026-10-01T00:00:00Z' },
]
const TRACKS: Track[] = NAMES.map((title, i) => {
  const source = i < 10 ? SOURCES[0]! : i < 18 ? SOURCES[1]! : SOURCES[2]!
  return {
    id: `t${i + 1}`,
    source_id: source.id,
    title,
    artist: ARTISTS[i % ARTISTS.length]!,
    bpm: [140, 142, 150, 128, 174, 136][i % 6]!,
    key: KEYS[i % KEYS.length]!,
    duration_s: 180 + i * 7,
    file_name: `${title.toLowerCase().replace(/ /g, '-')}.wav`,
    format: 'wav',
    missing: false,
    has_art: i % 5 !== 4,
  }
})
const PLAYLISTS: Playlist[] = [
  { id: 'pl-1', source_id: 'src-folder', name: 'Bass', kind: 'folder', track_count: 6 },
  { id: 'pl-2', source_id: 'src-folder', name: 'Warm-up', kind: 'folder', track_count: 4 },
  { id: 'pl-3', source_id: 'src-rb', name: 'Peak time', kind: 'playlist', track_count: 4 },
  { id: 'pl-4', source_id: 'src-rb', name: 'Tearout', kind: 'playlist', track_count: 3 },
  { id: 'pl-5', source_id: 'src-rb', name: 'Closers', kind: 'playlist', track_count: 1 },
  { id: 'pl-6', source_id: 'src-serato', name: 'Riddim', kind: 'crate', track_count: 4 },
  { id: 'pl-7', source_id: 'src-serato', name: 'Edits', kind: 'crate', track_count: 2 },
]

/** A cover: two tones of one hue per track, a soft disc (the design prototype's look). */
function cover(id: string): string {
  const h = Math.round((Number(id.replace(/\D/g, '')) || 0) * 137.5) % 360 // the golden angle: neighbours far apart
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},72%,58%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},64%,22%)"/></linearGradient></defs>
<rect width="300" height="300" fill="url(#g)"/><circle cx="${90 + (h % 120)}" cy="${110 + (h % 80)}" r="70" fill="hsl(${(h + 180) % 360},80%,70%)" opacity=".35"/></svg>`
}

export const mockLibrary = {
  art: (id: string): string => cover(id),
  sources: (): Source[] => (mockLibraryOn() ? SOURCES : []),
  playlists: (source: string): Playlist[] => (mockLibraryOn() ? PLAYLISTS.filter((p) => p.source_id === source) : []),
  /** A playlist is its source's first track_count tracks (made up). */
  tracks(url: URL): { total: number; offset: number; items: Track[] } {
    if (!mockLibraryOn()) return { total: 0, offset: 0, items: [] }
    const source = url.searchParams.get('source_id')
    const playlist = PLAYLISTS.find((p) => p.id === url.searchParams.get('playlist_id'))
    const q = url.searchParams.get('q')?.toLowerCase()
    let items = TRACKS.filter((t) => !source || t.source_id === source)
    if (playlist) items = items.filter((t) => t.source_id === playlist.source_id).slice(0, playlist.track_count)
    if (q) items = items.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q))
    return { total: items.length, offset: 0, items }
  },
}
