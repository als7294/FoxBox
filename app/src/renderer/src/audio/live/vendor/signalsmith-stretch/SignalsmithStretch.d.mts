/** Types for the vendored Signalsmith Stretch web release (the subset the live chain uses). */
export interface StretchSchedule {
  output?: number
  active?: boolean
  semitones?: number
  tonalityHz?: number
  formantSemitones?: number
  formantCompensation?: boolean
  formantBaseHz?: number
}

export interface StretchNode extends AudioWorkletNode {
  schedule(change: StretchSchedule): Promise<unknown>
  start(when?: number): Promise<unknown>
  stop(when?: number): Promise<unknown>
  /** Seconds of latency in live-input mode. */
  latency(): Promise<number>
  configure(config: { blockMs?: number; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<unknown>
}

interface SignalsmithStretchFactory {
  (context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>
  /** Where the worklet module is loaded from (set it: the default is a blob: URL, which the app's CSP blocks). */
  moduleUrl?: string
}

declare const SignalsmithStretch: SignalsmithStretchFactory
export default SignalsmithStretch
