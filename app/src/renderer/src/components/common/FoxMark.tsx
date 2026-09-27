import { forwardRef, useId } from 'react'

/**
 * The FoxBox mark (design/brand/foxbox-mark.svg): a fox face in negative space, drawn in `currentColor` (style it
 * with the ember accent). Decorative by default; pass `title` to make it an image with a name.
 */
export const FoxMark = forwardRef<SVGSVGElement, { size?: number; className?: string; title?: string }>(function FoxMark(
  { size = 26, className, title },
  ref,
) {
  // Each instance needs its own mask id (several marks can be on screen at once).
  const cut = `fox-cut-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {title && <title>{title}</title>}
      <defs>
        <mask id={cut}>
          <rect width="512" height="512" fill="#fff" />
          <path d="M118 78 L194 170 L132 206 Z" fill="#000" />
          <path d="M394 78 L318 170 L380 206 Z" fill="#000" />
          <path d="M148 244 L242 280 L224 312 L178 296 Z" fill="#000" />
          <path d="M364 244 L270 280 L288 312 L334 296 Z" fill="#000" />
          <path d="M30 302 L256 368 L482 302" fill="none" stroke="#000" strokeWidth="12" strokeLinejoin="miter" />
          <path d="M186 444 L256 456 L326 444" fill="none" stroke="#000" strokeWidth="10" strokeLinejoin="miter" />
        </mask>
      </defs>
      <path mask={`url(#${cut})`} fill="currentColor" d="M100 22 L204 166 L308 166 L412 22 L446 246 L488 302 L256 500 L24 302 L66 246 Z" />
    </svg>
  )
})
