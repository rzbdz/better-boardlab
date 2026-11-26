/**
 * Board art: a board's model, matched against the drawings this frontend ships, so a card can wear the board itself
 * as a faded background and a row or a page title can lead with its small drawing. Models are the product names a scan
 * reads from a board (a SoC prefix and the carrier's own name), which a person can also type in.
 *
 * A drawing is chosen by pattern, not by an exact list: `*pico*` is a carrier whatever a board calls itself, and
 * `not` keeps boards off a drawing they must not have (another SoC's board can share a word). Patterns ignore case and
 * `-`/`_`/spaces; first match wins, so the more specific drawing goes first. A model with no drawing gets the generic
 * board glyph, never another board's picture.
 *
 * The drawings live in ./assets as the frontend's own files (built to dist/ui/modern/assets), and a distribution that
 * ships none carries this file with no rules: every board then gets the generic glyph.
 */
export interface BoardArt {
  /** The drawing across a card's background (a product photo, cut out). */
  large: string
  /** The small drawing beside a name where there is no card (a list row, a page title). */
  icon: string
}

/** One shipped drawing: the file's base name is `name` (`assets/<name>.png`); `match`/`not` are wildcard patterns. */
const ART: Array<{ name: string, match: string[], not?: string[] }> = [
]

const normalize = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, '')
const pattern = (glob: string) => new RegExp(`^${normalize(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
const rules = ART.map(({ name, match, not }) => ({
  art: { large: `assets/${name}.png`, icon: `assets/${name}-icon.png` } as BoardArt,
  match: match.map(pattern), not: (not ?? []).map(pattern),
}))

/** The art for a board's model, if this frontend has one; null when it does not (the page shows the generic glyph). */
export function boardArt(product: string | null | undefined): BoardArt | null {
  if (!product) return null
  const model = normalize(product)
  for (const rule of rules) if (rule.match.some(re => re.test(model)) && !rule.not.some(re => re.test(model))) return rule.art
  return null
}
