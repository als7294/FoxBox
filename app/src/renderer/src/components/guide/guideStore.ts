/**
 * The GUIDE's state (2.0): which chapter is open (PLAY's or REMIX's) and its step; where a closed one stopped ("Continue
 * from step n"); and whether each chapter ran by itself once (a skipped first run counts: it never opens by itself again).
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** The full chapters, and 2.1.1's per-mode intros (3 steps each, on a mode's first entry: docs/MODE_ENTRY_UX.md §3). */
export type IntroChapter = 'intro-sauce' | 'intro-melody' | 'intro-remix'
export type Chapter = 'play' | 'remix' | IntroChapter

interface GuideState {
  open: Chapter | null
  step: number
  /** Where each chapter was left (null: finished, or never opened). */
  resume: Record<Chapter, number | null>
  /** It opened by itself once (first launch for PLAY, the first REMIX visit). */
  shown: Record<Chapter, boolean>
}

export const useGuide = create<GuideState>()(
  persist(
    () =>
      ({
        open: null,
        step: 0,
        resume: { play: null, remix: null, 'intro-sauce': null, 'intro-melody': null, 'intro-remix': null },
        shown: { play: false, remix: false, 'intro-sauce': false, 'intro-melody': false, 'intro-remix': false },
      }) as GuideState,
    {
      name: 'foxbox-guide',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ resume: s.resume, shown: s.shown }),
      // a 2.1 store has no intros yet: keep the new chapters' defaults
      merge: (saved, cur) => {
        const p = saved as Partial<GuideState> | undefined
        return { ...cur, resume: { ...cur.resume, ...p?.resume }, shown: { ...cur.shown, ...p?.shown } }
      },
    },
  ),
)

export const guide = {
  /** Opens a chapter at `step` (default: where it was left, else the start). */
  open(chapter: Chapter, step?: number) {
    const s = useGuide.getState()
    useGuide.setState({ open: chapter, step: step ?? s.resume[chapter] ?? 0, shown: { ...s.shown, [chapter]: true } })
  },
  go(step: number) {
    useGuide.setState({ step })
  },
  /** Closes it; `finished` clears the resume point, else the step is remembered. */
  close(finished = false) {
    const s = useGuide.getState()
    if (!s.open) return
    useGuide.setState({ open: null, resume: { ...s.resume, [s.open]: finished ? null : s.step } })
  },
}
