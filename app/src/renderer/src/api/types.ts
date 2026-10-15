import type { components } from './schema'

type S = components['schemas']

// contracts v1.0 (2.0: songs, stems, jobs, models, health, settings, audio)
export type ApiErrorBody = S['ApiError']
export type Health = S['Health']
export type Job = S['Job']
export type JobItem = S['JobItem']
export type ModelInfo = S['ModelInfo']
export type Peaks = S['Peaks']
export type Settings = S['Settings']
/**
 * v0.10's structure. `builds` is (build start s, drop hit s) pairs, typed number[][] rather than the schema's tuple:
 * openapi-fetch's response mapping turns tuples into arrays, and Song must match what the client returns.
 */
export type SongStructure = Omit<S['SongStructure'], 'builds'> & { builds?: number[][] }
export type Song = Omit<S['Song'], 'structure'> & { structure?: SongStructure | null }
export type SongAnalysis = S['SongAnalysis']
export type SongUpdate = S['SongUpdate']
