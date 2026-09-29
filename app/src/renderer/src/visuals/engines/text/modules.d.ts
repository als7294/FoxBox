// troika-three-text ships no types; only what FoxBox uses.
declare module 'troika-three-text' {
  import type { Mesh } from 'three'
  export class Text extends Mesh {
    text: string
    font: string | null
    fontSize: number
    anchorX: number | string
    anchorY: number | string
    letterSpacing: number
    color: number | string
    fillOpacity: number
    outlineWidth: number | string
    outlineBlur: number | string
    outlineColor: number | string
    outlineOpacity: number
    /** Per-character colours: { charIndex: colour } runs until the next key. */
    colorRanges: Record<number, number | string> | null
    textRenderInfo: { blockBounds: [number, number, number, number] } | null
    sync(callback?: () => void): void
    dispose(): void
  }
  export function configureTextBuilder(config: { useWorker?: boolean; unicodeFontsURL?: string }): void
}
