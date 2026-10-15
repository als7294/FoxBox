// The app's shared AudioContext for decoding (songs, the boot screen's rate). 2.0: out of the Studio's A/B player.
let sharedContext: AudioContext | null = null

export function audioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext({ latencyHint: 'interactive' })
  return sharedContext
}

export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  // decodeAudioData detaches its input; keep the caller's copy intact.
  return audioContext().decodeAudioData(data.slice(0))
}
