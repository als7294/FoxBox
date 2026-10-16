/**
 * The words that differ on Windows (the W1 beta), through t() so each language says them its own way: the shortcut
 * keys (⌘ / Ctrl), the file browser (Finder / File Explorer), the computer (this Mac / this PC). Strings put them in
 * with placeholders: t('stage.take.reveal', 'Show in {files}', { files: files() }).
 */
import { isWindows } from '@/env'
import { t } from '@/i18n'

/** A shortcut written the Mac's way, in the platform's notation: '⌘,' → 'Ctrl+,', '⌘ ⇧ E' → 'Ctrl+Shift+E',
 *  '⌥ ↩' → 'Alt+Enter'. */
export function keys(mac: string): string {
  if (!isWindows()) return mac
  return mac.replace(/\s*⌘\s*/g, 'Ctrl+').replace(/\s*⇧\s*/g, 'Shift+').replace(/\s*⌥\s*/g, 'Alt+').replace(/↩/g, 'Enter')
}

/** The file browser: Finder / File Explorer (the language's article with it where it takes one). */
export const files = (): string => (isWindows() ? t('platform.files.win', 'File Explorer') : t('platform.files.mac', 'Finder'))

/** This computer, as in "Nothing leaves {computer}.": this Mac / this PC. */
export const computer = (): string => (isWindows() ? t('platform.computer.win', 'this PC') : t('platform.computer.mac', 'this Mac'))
