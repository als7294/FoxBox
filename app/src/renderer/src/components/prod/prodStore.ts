/**
 * STRINGS' own state (the 'prod' screen; until 1.5.5 it carried PROD · TOUCHDESIGNER's too): the preview's format and
 * FACE HIDING, both kept.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ClipAspect } from '@/components/clips/liveCapture'

interface ProdState {
  aspect: ClipAspect
  /** 1.5.5, STRINGS: FoxBox's face hiding over the picture. Off by default (the user: visible by default on STRINGS). */
  faceHiding: boolean
  /** 2.0 REMIX's RECORD: a video (camera + strings + audio) or the audio alone (a WAV take). */
  recordKind: 'video' | 'wav'

  setAspect(aspect: ClipAspect): void
  setFaceHiding(on: boolean): void
  setRecordKind(kind: 'video' | 'wav'): void
}

export const useProd = create<ProdState>()(
  persist(
    (set) => ({
      aspect: '16:9',
      faceHiding: false,
      recordKind: 'video',
      setAspect: (aspect) => set({ aspect }),
      setFaceHiding: (faceHiding) => set({ faceHiding }),
      setRecordKind: (recordKind) => set({ recordKind }),
    }),
    {
      name: 'foxbox-prod',
      storage: createJSONStorage(() => localStorage),
      // 1.5.5, STRINGS: opens at 16:9 (the hands need the camera's full width); an aspect saved by PROD · TOUCHDESIGNER
      // (version 0) doesn't carry over, the user's pick from then on does
      version: 1,
      migrate: (saved, version) => (version < 1 ? { ...(saved as object), aspect: '16:9' } : saved) as ProdState,
      partialize: (s) => ({ aspect: s.aspect, faceHiding: s.faceHiding, recordKind: s.recordKind }),
    },
  ),
)
