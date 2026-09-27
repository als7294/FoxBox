import { describe, expect, it } from 'vitest'
import { errorResponse, parseEngineRequest, pickHeaders } from '../../../src/main/engineProxy'

const ok = (raw: unknown) => {
  const r = parseEngineRequest(raw)
  if ('error' in r) throw new Error(r.error)
  return r.request
}
const bad = (raw: unknown) => {
  const r = parseEngineRequest(raw)
  expect('error' in r).toBe(true)
}

describe('engine proxy request validation', () => {
  it('accepts /api/ requests and keeps only safe headers', () => {
    const r = ok({
      id: 'r1',
      method: 'POST',
      path: '/api/render?x=1',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer evil', Host: 'x', Accept: 'application/json' },
      body: new TextEncoder().encode('{}').buffer,
    })
    expect(r.path).toBe('/api/render?x=1')
    expect(r.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json' })
    expect(r.body?.byteLength).toBe(2)
  })

  it('rejects anything outside /api/ or odd methods', () => {
    bad({ id: 'r', method: 'GET', path: '/etc/passwd', headers: {} })
    bad({ id: 'r', method: 'GET', path: 'http://evil.example/api/health', headers: {} })
    bad({ id: 'r', method: 'GET', path: '/api/../admin', headers: {} })
    bad({ id: 'r', method: 'GET', path: '/api/%2e%2e/admin', headers: {} })
    bad({ id: 'r', method: 'GET', path: '//evil.example/api/x', headers: {} })
    bad({ id: 'r', method: 'TRACE', path: '/api/health', headers: {} })
    bad({ id: '', method: 'GET', path: '/api/health', headers: {} })
    bad({ id: 'r', method: 'POST', path: '/api/render', headers: {}, body: 'not binary' })
    bad(null)
  })

  it('drops bodies on GET and header values with newlines', () => {
    const r = ok({ id: 'r', method: 'GET', path: '/api/health', headers: { accept: 'a\r\nX-Evil: 1' }, body: new ArrayBuffer(4) })
    expect(r.body).toBeNull()
    expect(r.headers).toEqual({})
  })

  it('answers errors in the engine envelope', () => {
    const res = errorResponse(503, 'engine_offline', 'down', 'wait', true)
    expect(res.status).toBe(503)
    expect(JSON.parse(new TextDecoder().decode(res.body!))).toEqual({ error: { code: 'engine_offline', message: 'down', hint: 'wait', retryable: true } })
    expect(pickHeaders(new Headers({ 'content-type': 'audio/wav', 'set-cookie': 'x' }))).toEqual({ 'content-type': 'audio/wav' })
  })
})
