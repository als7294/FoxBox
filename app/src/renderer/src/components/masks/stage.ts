/**
 * The MASKS page's 3D stage and part pictures: S1's renderer (camera/maskStage.ts, maskThumbs.ts), under the names the
 * page uses.
 */
export {
  createMaskStage,
  type MaskStage,
  type StageView,
  type SoloFx as StageFx,
  type LineupAct as StageAct,
  type StageBeat as Beat,
} from '@/components/camera/maskStage'
export { renderThumb, peekThumb, type ThumbFraming as Framing } from '@/components/camera/maskThumbs'
