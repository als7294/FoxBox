# REMIX library wheel (FoxBox 2.0)

**The user's ask (2026-10-15):** "add a way in remix to browse a local library (or your serato/rekordbox stuff) exactly like this by doing a custom hand sign".

The reference is a TouchDesigner + MediaPipe reel. It's in the PM's scratchpad as `reel/sheet.jpg`, and it is not committed, because it's a third party's video.

## What the reference does
- A big 3D **ring of cover cards**: many thin cards fanned around a hollow centre, seen in perspective. Each card's **title and index number** radiate outward on thin lines, and a **pointer line** rises from the bottom with the current **angle in degrees**.
- **The right index finger is a dial.** The finger's angle (about 140°–280°) turns the ring directly, like a knob.
- **Closing the left hand pulls the selected card out** toward you, big, in front of the ring. Opening it sends the card back. Its readout runs "Scale 0 → 0.5" as the hand closes.

## FoxBox version
- **Open and close:** hold the 🤙 **shaka** sign (thumb and pinky out, the rest curled) for ~0.5 s. It's distinct from REMIX's six shapes. The same sign closes the wheel, and so does Esc.
  - While the wheel is open, REMIX's beat-FX shapes and finger filters are suspended; the song keeps playing.
- **Spin:**
  - The right index finger's angle drives the ring, mapped with a gain so a comfortable ~140° sweep covers a page of ~40 tracks.
  - Holding the finger near either end of its range keeps scrolling (like an edge scroll) for big libraries.
  - It's smoothed, and the selected card snaps to the pointer.
- **Grab:**
  - Closing the left hand (0 → 1) pulls the selected card out, at full size from ~0.7.
  - At the full pull, a **preview** plays (~20 s from about 40% into the track, which is usually near the drop), ducking the deck.
  - Opening the hand puts the card back and stops the preview.
- **Load:** hold the full grab for ~0.8 s (a fill ring shows the progress) and the track loads into REMIX. That's the same path as dropping a file: analysis, then the stems notice and split. The wheel then closes.
- **Mouse and keys too:** the scroll wheel spins, a click previews, a double-click loads, and typing searches.

## Sources (any mix)
- **A music folder** the user picks (e.g. ~/Music): audio files with their tags and embedded artwork.
- **Rekordbox** through its **XML export**. In Rekordbox, choose File → Export Collection in xml format, then pick that file in FoxBox. That gives the collection and playlists with BPM and key.
  - Reading Rekordbox's encrypted master.db directly would mean extracting Pioneer's key, so we don't. The XML export is Rekordbox's official route.
- **Serato** from `~/Music/_Serato_`: `database V2` plus the `Subcrates/*.crate` files, read with our own small parser. Serato DJ 4's SQLite library is also read when present.
- Artwork comes from the files' own tags; there's a neutral card when a file has none.
- **The track list's filter:** pick a source, playlist or crate with the mouse in a small panel. The hands only spin, grab and load.

## Rules
- The engine only ever reads folders and files the user picked through the native dialog in main, or Serato's standard folder. The renderer never sends paths; tracks are addressed by id.
- **No network.** Libraries of 10k+ tracks must open in under ~1 s after the first scan, so index and cache them.
- **The wheel follows the 2.0 look:** its colours and type come from the Claude Design tokens (`--wheel-*`), and the camera stays visible behind it.

## Owners
| Session | Work |
|---|---|
| S3 | Engine readers + routes (contracts v1.1), tests with synthetic fixtures |
| S1 | Gestures: the shaka, the dial angle, the left-hand grab amount, hold-to-load |
| S2 | The ring (three.js) and the preview audio |
| S4 | SettingsSheet "Library" (add a folder, pick the rekordbox.xml, Serato detected), the main-process pickers, integration |
| PM | Contracts ruling, design addendum |
