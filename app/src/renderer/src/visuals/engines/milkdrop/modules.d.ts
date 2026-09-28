// butterchurn and butterchurn-presets ship no types; only what FoxBox uses.

declare module 'butterchurn' {
  export interface AudioLevels {
    timeByteArray: Uint8Array
    timeByteArrayL: Uint8Array
    timeByteArrayR: Uint8Array
  }
  export interface Visualizer {
    loadPreset(preset: object, blendTimeSeconds?: number): void
    setRendererSize(width: number, height: number, opts?: { pixelRatio?: number; textureRatio?: number }): void
    render(opts?: { audioLevels?: AudioLevels; elapsedTime?: number }): void
  }
  const butterchurn: {
    createVisualizer(
      context: BaseAudioContext,
      canvas: HTMLCanvasElement,
      opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
    ): Visualizer
  }
  export default butterchurn
}

declare module 'butterchurn-presets' {
  const presets: { getPresets(): Record<string, MilkdropPresetData> }
  export default presets
}

/** A preset as butterchurn-presets ships it (equations as strings). */
interface MilkdropPresetData {
  shapes: Record<string, unknown>[]
  waves: Record<string, unknown>[]
  [key: string]: unknown
}
