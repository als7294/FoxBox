<!-- Scratch: the GitHub release body for v2.0.0. Not shipped; paste into `gh release create`. -->
## FoxBox 2.0: an instrument for your hands

Curve your hands into a C in front of the camera, and strings of light stretch between your fingertips.

- **SAUCE:** make sounds with no song. A hand's height picks the note; curl a finger to pluck. Two hands play two notes. Twist to bend, shake for vibrato, point up or down for the octave. Seven sounds, melodies to play along with, and 🎲 for a new one.
- **REMIX:** load a song and remix it with your hands. Hold a shape for beat-locked FX (TEAROUT, RIDDIM CHOPS, WOBBLE, HALFTIME, SUB DROP, BUILD ROLL), fold a finger to cut its band, and ▶ starts just before the drop.
- **Frames:** make a frame and the last 4 beats loop inside it, picture and sound. Pinch and hold for a moment to change the effect, and turn both hands over for its flip side. Let go and it shatters.
- **The library wheel:** hold the shaka 🤙 or press L. Spin with your right index, preview and load with your left hand. It reads a music folder, a Rekordbox XML export or your Serato library.
- **Board, Visuals and Record:** knobs for the sound or the song, five visuals, and WAV or video takes you can drag into Ableton, Rekordbox or Finder.
- **Make it yours:** Edit shapes in Hands or Beat FX; pluck sensitivity and a left-handed layout in Settings (in FLOW your left hand plays and your right makes the shapes; the library dial moves to your left index). The GUIDE (G) walks you through it with your own camera.

**Looking for STUDIO, VISUALS, MASKS or the voice mask?** FoxBox 2.0 is the hands instrument only. The full toolkit stays available as [FoxBox 1.5.5](https://github.com/als7294/FoxBox/releases/tag/v1.5.5). Updating doesn't delete any of your files.

**Install:** download the DMG (macOS 14+, Apple silicon, a camera). **Already on 1.5?** FoxBox updates itself in the app. This update is bigger, once: about 180 MB, because FoxBox's engine is replaced with a much smaller one. Later updates are small again.

**Free up space (1.x users):** FoxBox 2.0 no longer uses 1.x's voice models (Kokoro, Qwen3-TTS, DeepFilterNet, Whisper and the aligner), up to ~12 GB. They're the `models--…` folders in `~/Library/Application Support/FoxBox/models/hub`, and every one except `models--mlx-community--demucs-mlx-fp16` (REMIX's stem splitter) is safe to delete.

If the camera stays dark after updating, open System Settings → Privacy & Security → Camera and turn FoxBox on, or run `tccutil reset Camera com.smittytech.foxbox`.

The stem splitter's weights are Meta's (Demucs), licensed for scientific use only; FoxBox says so before the download.
