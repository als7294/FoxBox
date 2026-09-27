import styles from './common.module.css'

/**
 * The designer credit. Required on the boot screen, SETTINGS, the ? overlay and every installer surface; never in
 * exported files. The address is injected at build time (`__CREDIT_EMAIL__`, from the gitignored credit.local.json
 * or FVWKS_CREDIT_EMAIL) and never committed; without it the credit is plain text.
 */
export const CREDIT_TEXT = 'Designed by SmittyTech'
export const creditHref = (email: string = __CREDIT_EMAIL__): string | null => (email ? `mailto:${email}` : null)

/**
 * "v0.1.0 · DESIGNED BY SMITTYTECH", a mailto link when the build has the address (main opens it in the mail app;
 * see isExternalLink in src/main/index.ts). Quiet: mono small caps in dim ink, amber on hover and focus, 12 px min.
 */
export function CreditLink({ version = __APP_VERSION__, className }: { version?: string | null; className?: string }) {
  const href = creditHref()
  const cls = className ? `${styles.credit} ${className}` : styles.credit
  const text = `${version ? `v${version} · ` : ''}${CREDIT_TEXT}`
  return href ? (
    <a className={cls} href={href} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span className={cls}>{text}</span>
  )
}
