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
          <path d="M112 104 L196 190 L130 222 Z" fill="#000" />
          <path d="M400 104 L316 190 L382 222 Z" fill="#000" />
          <path d="M140 250 L248 290 L226 330 L176 306 Z" fill="#000" />
          <path d="M372 250 L264 290 L286 330 L336 306 Z" fill="#000" />
          <path d="M56 298 L256 410 L456 298" fill="none" stroke="#000" strokeWidth="28" strokeLinejoin="miter" />
        </mask>
      </defs>
      <path mask={`url(#${cut})`} fill="currentColor" d="M96 56 L204 172 L308 172 L416 56 L452 296 L256 470 L60 296 Z" />
    </svg>
  )
})
