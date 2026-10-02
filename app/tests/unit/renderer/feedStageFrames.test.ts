import { describe, expect, it } from 'vitest'
import { silentFrame } from '@/visuals/live/registry'
import { feedStageFrames, stageFrames } from '@/visuals/live/stage'

describe('feedStageFrames', () => {
  it('lets one stage feed at a time, and another take over once it goes quiet', () => {
    const fed: string[] = []
    const listen = () => fed.push(who)
    let who = ''
    stageFrames.add(listen)
    const visuals = {}
    const prod = {}
    const a = silentFrame(0)
    who = 'visuals'
    feedStageFrames(visuals, a, 16, 1000)
    who = 'prod'
    feedStageFrames(prod, a, 16, 1010) // VISUALS fed 10 ms ago: PROD waits
    who = 'visuals'
    feedStageFrames(visuals, a, 16, 1016)
    who = 'prod'
    feedStageFrames(prod, a, 16, 1200) // VISUALS quiet for 184 ms: PROD takes over
    who = 'visuals'
    feedStageFrames(visuals, a, 16, 1210)
    stageFrames.delete(listen)
    expect(fed).toEqual(['visuals', 'visuals', 'prod'])
  })
})
