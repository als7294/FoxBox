import type { ButtonHTMLAttributes } from 'react'
import styles from './common.module.css'

/**
 * primary: accent CTA (RENDER ALL) · ink: filled light CTA (EXPORT, ADD LINES, DONE) · secondary: hairline
 * mono caps · ghost: borderless dim (CLEAR) · danger: accent outline (RETRY) · amber: amber chip (FIX).
 */
type Variant = 'primary' | 'ink' | 'secondary' | 'ghost' | 'danger' | 'amber'
type Size = 'sm' | 'md' | 'lg'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...rest}
      className={[styles.button, className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
    />
  )
}

/** Small square icon button (×, −, +). Always give it an aria-label. */
export function IconButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={[styles.iconButton, className].filter(Boolean).join(' ')} />
}
