/** FoxBox's live audio (2.0: REMIX's TRACK): the engine, the shared bus, the song deck and its stems. */
export { LiveEngine, type LiveEngineOptions } from './engine'
export type { LiveBus, LiveBands, LiveOnset, LiveTrigger, LiveTriggerEvent, Quantize } from './bus'
export { SongDeck, clockAt, type BeatClock } from './songDeck'
export type { AudioTap } from './bus'
export { StemTrack, StemTrackReader, LiveStems, type StemFeaturesJson, type StemsFrame } from './stems'
