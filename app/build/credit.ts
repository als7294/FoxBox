// The designer credit's contact address, injected at build time and never committed: `FVWKS_CREDIT_EMAIL`, else
// the gitignored `credit.local.json` ({"email": "..."}) next to package.json. Neither set (or not an address): ''
// and the credit shows as plain text. Never fails a build.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ADDRESS = /^[^\s@<>"'`()]+@[^\s@<>"'`()]+\.[A-Za-z]{2,}$/

export function creditEmail(env: NodeJS.ProcessEnv = process.env, file = resolve(__dirname, '..', 'credit.local.json')): string {
  const fromEnv = env.FVWKS_CREDIT_EMAIL?.trim()
  if (fromEnv) return ADDRESS.test(fromEnv) ? fromEnv : ''
  try {
    const email = (JSON.parse(readFileSync(file, 'utf8')) as { email?: unknown }).email
    return typeof email === 'string' && ADDRESS.test(email.trim()) ? email.trim() : ''
  } catch {
    return ''
  }
}
