// interactive-shader-format ships no types; only what FoxBox uses.
declare module 'interactive-shader-format' {
  export class Renderer {
    constructor(gl: WebGLRenderingContext)
    valid: boolean
    error: unknown
    loadSource(fragmentISF: string, vertexISF?: string): void
    setValue(name: string, value: unknown): void
    draw(destination: { width: number; height: number }): void
    cleanup?(): void
  }
}
