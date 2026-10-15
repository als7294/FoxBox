import type { Pt, Pt3 } from '@/components/camera/camMath'

/** A hand in metres (MediaPipe's world landmarks): the palm flat, fingers up the frame along their knuckles; `fold[f]`
 *  folds finger f (thumb first) toward the palm, 0 straight … 1 a fist's (MCP 90°, PIP 100°, DIP 70°; the thumb's tip
 *  tucked in by the middle knuckle). With its points in a frame of `aspect` (0-1, the wrist about (x, y)). `roll`: turned
 *  that many degrees about its own long axis (90: edge-on); `turn`: then clockwise on screen (90: fingers to the right);
 *  `mirror`: the other hand (the thumb on the right); `thumbSide`: an out thumb straight out sideways (an L's). */
export function hand3d(
  fold: number[],
  x = 0.3,
  y = 0.6,
  aspect = 16 / 9,
  { roll = 0, turn = 0, mirror = false, thumbSide = false } = {},
): { points: Pt[]; world: Pt3[]; gesture: null } {
  const p: [number, number, number][] = Array.from({ length: 21 }, () => [0, 0, 0])
  ;[[-0.03, -0.085], [-0.01, -0.09], [0.01, -0.087], [0.03, -0.08]].forEach(([kx, ky], i) => {
    const k = 5 + i * 4
    const n = Math.hypot(kx!, ky!)
    let [px, py, pz, phi] = [kx!, ky!, 0, 0]
    p[k] = [px, py, pz]
    ;[0.045, 0.027, 0.022].forEach((len, j) => {
      phi += (fold[i + 1]! * [90, 100, 70][j]! * Math.PI) / 180
      px += (len * Math.cos(phi) * kx!) / n
      py += (len * Math.cos(phi) * ky!) / n
      pz += len * Math.sin(phi)
      p[k + 1 + j] = [px, py, pz]
    })
  })
  const t = fold[0]!
  const mix = (a: number[], b: number[]): [number, number, number] => [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as [number, number, number]
  p[1] = [-0.025, -0.025, 0]
  p[2] = [-0.045, -0.045, 0]
  p[3] = mix(thumbSide ? [-0.075, -0.045, 0] : [-0.065, -0.065, 0], [-0.03, -0.06, 0.02])
  p[4] = mix(thumbSide ? [-0.105, -0.045, 0] : [-0.085, -0.085, 0], [-0.005, -0.075, 0.02]) // tucked: by the middle knuckle, as a real fist's
  const [r, u] = [(roll * Math.PI) / 180, (turn * Math.PI) / 180]
  const world = p
    .map(([wx, wy, wz]) => [mirror ? -wx : wx, wy, wz] as const)
    .map(([wx, wy, wz]) => [wx * Math.cos(r) + wz * Math.sin(r), wy, -wx * Math.sin(r) + wz * Math.cos(r)] as const)
    .map(([wx, wy, wz]) => ({ x: wx * Math.cos(u) - wy * Math.sin(u), y: wx * Math.sin(u) + wy * Math.cos(u), z: wz }))
  return { world, points: world.map((q) => ({ x: x + (q.x * 2) / aspect, y: y + q.y * 2 })), gesture: null }
}
