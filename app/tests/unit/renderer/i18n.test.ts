import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DICTS, LANGS, systemLang, t, useLang } from '../../../src/renderer/src/i18n'

const SRC = join(__dirname, '../../../src/renderer/src')

/** Every t('key', 'English') in the renderer: key → English. */
function codeKeys(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) { if (f !== 'i18n') walk(p) } // the i18n module's own docs show t() examples
      else if (/\.tsx?$/.test(f)) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/\bt\(\s*'([\w.-]+)'\s*,\s*(['"`])((?:\\.|(?!\2).)*)\2/gs)) out.set(m[1] ?? '', m[3] ?? '')
      }
    }
  }
  walk(SRC)
  return out
}

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('i18n', () => {
  const keys = codeKeys()

  describe.each(Object.entries(DICTS))('%s', (lang, dict) => {
    it('covers every key in the code, with the same {placeholders}', () => {
      expect([lang, [...keys.keys()].filter((k) => !(k in dict))]).toEqual([lang, []])
      for (const [k, en] of keys) expect([k, vars(dict[k] ?? '')]).toEqual([k, vars(en)])
    })

    it('has no keys the code no longer uses', () => {
      expect([lang, Object.keys(dict).filter((k) => !keys.has(k))]).toEqual([lang, []])
    })
  })

  it('every language with a dictionary is listed, and every listed one has a dictionary', () => {
    expect(LANGS.map((l) => l.id).filter((id) => id !== 'en').sort()).toEqual(Object.keys(DICTS).sort())
  })

  it('t() falls back to the English, fills {vars}, and follows the chosen language', () => {
    useLang.getState().setChoice('en')
    expect(t('test.none', 'Bar {n} of {total}', { n: 3, total: 8 })).toBe('Bar 3 of 8')
    useLang.getState().setChoice('es')
    expect(t('test.none', 'Only English')).toBe('Only English')
    useLang.getState().setChoice('system')
  })

  it('translated release notes match their English: a title and the same number of lines', () => {
    const dir = join(__dirname, '../../../release-notes')
    const shape = (md: string) => [md.split('\n').filter((l) => l.startsWith('# ')).length, md.split('\n').filter((l) => l.startsWith('- ')).length]
    for (const lang of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
      expect(Object.keys(DICTS)).toContain(lang)
      for (const f of readdirSync(join(dir, lang))) {
        expect([lang, f, shape(readFileSync(join(dir, lang, f), 'utf8'))]).toEqual([lang, f, shape(readFileSync(join(dir, f), 'utf8'))])
      }
    }
  })

  it('systemLang picks a shipped language or English', () => {
    expect(systemLang('es-MX')).toBe('es')
    expect(systemLang('en-GB')).toBe('en')
    expect(systemLang('pt-BR')).toBe('pt')
    expect(systemLang('ja-JP')).toBe('ja')
    expect(systemLang('it-IT')).toBe('en')
  })
})
