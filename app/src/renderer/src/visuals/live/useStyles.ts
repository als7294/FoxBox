import { useEffect, useState } from 'react'
import { listFamilies, onFamiliesChange, type VisualStyle } from './registry'

export interface StyleGroup {
  id: string
  label: string
  styles: VisualStyle[]
}

/** Every registered family's styles, grouped for a picker (refreshes when a family registers or changes). */
export function useStyleGroups(): StyleGroup[] {
  const [groups, setGroups] = useState<StyleGroup[]>([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      const out: StyleGroup[] = []
      for (const f of listFamilies()) {
        try {
          out.push({ id: f.id, label: f.label, styles: await f.styles() })
        } catch (err) {
          console.warn(`visual family ${f.id} did not list its styles`, err)
        }
      }
      if (alive) setGroups(out)
    }
    void load()
    const off = onFamiliesChange(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [])
  return groups
}
