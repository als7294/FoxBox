# Addendum to the FoxBox design brief
_Paste this into Claude Design as a follow-up message. Attach `contracts/examples/*.json` and `contracts/rack.v0.json` so you design against real data._

1. **Window chrome.** This is a macOS app with a hidden-inset title bar. Leave room for the traffic lights at the top left, and make the TopBar a draggable title region. Design at 1512×982, and show a **1280×800** layout too.
2. **The rack is data-driven.** Design ONE generic **ModuleCard** that renders any module from its param list. Each param has a label, a control kind (knob / fader / switch / select / segmented / number), a unit, a range and an "advanced" flag, as in `rack.v0.json`. Show one module card closed, one open, one with advanced params revealed, and one "not available yet" (bypassed with a note).
3. **Macro rings.** Each of the 4 macro knobs shows a ring or list of the params it drives, from the preset's macro map. Macros default to 0.5, which is the preset as designed.
4. **Add these components:** Waveform, MiniWaveform, Transport, ABToggle, VoiceCard, TakeList (recorder takes), InputMeter, Tooltip, Modal, and form fields (text, number, select, path picker).
5. **Add these states:** engine restarting; exporting; analysis pending (the waveform is ready but the mask is still warming up); and a stack voice that failed to synthesize.
6. **Keyboard.** Show that global shortcuts pause while the ScriptEditor has focus, for example with a subtle "typing" indicator.
7. **Fonts.** Bundle them locally as woff2, OFL only. No web font CDNs.
