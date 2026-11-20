import { randomBytes } from 'node:crypto'

/** Callback data of a command button: the text it sends, or the key of a longer text kept here */
const INLINE = 'llb:i:'
const KEPT = 'llb:k:'
const LIMIT = 64
/** Long texts kept for this many buttons; the oldest go first, and all of them on a restart */
const KEEP = 2000

/**
 * Telegram has no button that sends a message for the user: a command button is a callback button whose data
 * names the text, and its click comes in as that text from the user who clicked.
 */
export class CommandButtons {
  private kept = new Map<string, string>()

  encode(text: string): string {
    const inline = INLINE + text
    if (Buffer.byteLength(inline) <= LIMIT) return inline
    for (const [key, value] of this.kept) if (value === text) return KEPT + key
    const key = randomBytes(9).toString('base64url')
    this.kept.set(key, text)
    if (this.kept.size > KEEP) this.kept.delete(this.kept.keys().next().value!)
    return KEPT + key
  }

  /** The text of a command button's callback data; undefined for other buttons, or a long text forgotten */
  decode(data: string | undefined): string | undefined {
    if (!data) return
    if (data.startsWith(INLINE)) return data.slice(INLINE.length)
    if (data.startsWith(KEPT)) return this.kept.get(data.slice(KEPT.length))
  }

  /** Whether the data is a command button's, known or not */
  isCommand(data: string | undefined) {
    return !!data && (data.startsWith(INLINE) || data.startsWith(KEPT))
  }
}
