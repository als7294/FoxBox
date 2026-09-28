import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { refreshS3Families } from '../../live/families/s3'
import { favourites, loadPresets, onFavouritesChange, searchPresets, toggleFavourite, type MilkdropPreset } from './presets'
import styles from './milkdrop.module.css'

/**
 * MILKDROP's preset browser, for the style picker when the MILKDROP family is open: search (every word, any order),
 * ★ favourites (this machine; listed first, and what the AUTO cycles play once there are two).
 */
export function MilkdropBrowser({ selected, onPick }: { selected: string | null; onPick(styleId: string): void }) {
  const [presets, setPresets] = useState<MilkdropPreset[] | null>(null)
  const [query, setQuery] = useState('')
  const [fav, setFav] = useState(favourites)

  useEffect(() => {
    void loadPresets().then(setPresets)
    return onFavouritesChange(() => setFav(favourites()))
  }, [])
  const shown = useMemo(() => (presets ? searchPresets(presets, query, fav) : []), [presets, query, fav])
  const stop = Math.max(0, shown.findIndex((p) => `milkdrop.${p.slug}` === selected))
  // One tab stop for the list: Up/Down between presets, Right to its ★, Left back.
  const keys = (e: KeyboardEvent<HTMLUListElement>) => {
    const names = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-name]')]
    const el = document.activeElement as HTMLButtonElement
    const row = names.indexOf(el.dataset.star !== undefined ? (el.previousElementSibling as HTMLButtonElement) : el)
    if (row < 0) return
    const go = { ArrowDown: row + 1, ArrowUp: row - 1, Home: 0, End: names.length - 1 }[e.key]
    if (go !== undefined) names[Math.max(0, Math.min(names.length - 1, go))]?.focus()
    else if (e.key === 'ArrowRight') (names[row]?.nextElementSibling as HTMLButtonElement | null)?.focus()
    else if (e.key === 'ArrowLeft') names[row]?.focus()
    else return
    e.preventDefault()
  }

  return (
    <div className={styles.browser}>
      <input className={styles.search} type="search" placeholder={presets ? `Search ${presets.length} presets` : 'Loading presets…'}
        value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search Milkdrop presets" />
      <ul className={styles.list} role="listbox" aria-label="Milkdrop presets" onKeyDown={keys}>
        {shown.map((p, i) => {
          const id = `milkdrop.${p.slug}`
          const liked = fav.has(p.slug)
          return (
            <li key={p.slug} className={styles.row} role="option" aria-selected={selected === id} data-selected={selected === id || undefined}>
              <button type="button" data-name tabIndex={i === stop ? 0 : -1} className={styles.name} onClick={() => onPick(id)}>
                {p.name}
              </button>
              <button type="button" data-star tabIndex={-1} className={styles.star} aria-pressed={liked} aria-label={liked ? `Unstar ${p.name}` : `Star ${p.name}`}
                onClick={() => {
                  toggleFavourite(p.slug)
                  refreshS3Families()
                }}>
                {liked ? '★' : '☆'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
