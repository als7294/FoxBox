import { create } from 'zustand'

/** 2.1 boot splash: milestones only their owners see (the hands model loaded, the strings' canvas made). */
export const useBootMarks = create<{ tracking: boolean; strings: boolean }>(() => ({ tracking: false, strings: false }))

export function markBoot(mark: 'tracking' | 'strings'): void {
  if (!useBootMarks.getState()[mark]) useBootMarks.setState({ [mark]: true })
}
