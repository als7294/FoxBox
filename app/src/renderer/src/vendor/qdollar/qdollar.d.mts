// Types for qdollar.mjs (the $Q recognizer's JavaScript version, vendored; see README.md).
export class Point {
  constructor(x: number, y: number, id: number)
  X: number
  Y: number
  ID: number
}
export interface Result {
  Name: string
  /** 1 / the point clouds' distance (1 at most): higher is closer. */
  Score: number
  Time: number
}
export class QDollarRecognizer {
  constructor()
  /** Its templates: 16 of its own, then those added. */
  PointClouds: { Name: string }[]
  Recognize(points: Point[]): Result
  AddGesture(name: string, points: Point[]): number
  DeleteUserGestures(): number
}
