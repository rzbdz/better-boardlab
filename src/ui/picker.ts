/**
 * A list to pick one item from, opened from a title: what every frontend's picker does, drawn by each in its own style.
 * The title stays text (it can still be selected and copied) with a button's role: a click or tap, Enter, Space or an
 * arrow key opens the list; the arrows move, Enter picks, Esc closes and gives the focus back. A long list gets a filter
 * box. A press outside, or the focus leaving, closes it. While it is open its keys stay inside, so the page's own
 * shortcuts do not fire. Picking the item shown now only closes the list.
 */
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react'

export interface PickerOptions<T> {
  items: readonly T[]
  key: (item: T) => string
  /** What the filter box matches, case-blind. */
  text: (item: T) => string
  /** The key of the item shown now: marked in the list, and where the list opens. */
  current: string
  onPick: (item: T) => void
  /** A list longer than this gets a filter box. */
  filterFrom?: number
}

export function usePicker<T>(options: PickerOptions<T>) {
  const { items, key, text, current, onPick, filterFrom = 8 } = options
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const filtering = items.length > filterFrom
  const q = query.trim().toLowerCase()
  const shown = q ? items.filter(item => text(item).toLowerCase().includes(q)) : items
  const at = shown.length ? Math.min(Math.max(active, 0), shown.length - 1) : -1
  const listId = `${id}-list`, optionId = (index: number) => `${id}-o${index}`

  const show = () => { setQuery(''); setActive(Math.max(0, items.findIndex(item => key(item) === current))); setOpen(true) }
  const close = (focus: boolean) => { setOpen(false); if (focus) trigger.current?.focus() }
  const pick = (item: T) => { close(true); if (key(item) !== current) onPick(item) }

  // Opened: the filter box (or the list) takes the keys.
  useEffect(() => { if (open) (filtering ? input.current : list.current)?.focus() }, [open, filtering])
  // A press anywhere outside closes it (a mouse, a finger or a pen).
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  // The item the keys are on stays in sight in a list that scrolls.
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView?.({ block: 'nearest' }) }, [open, at])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (event.target === trigger.current && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show() }
      return
    }
    event.stopPropagation()
    const inInput = event.target === input.current
    const move = (to: number) => { event.preventDefault(); if (shown.length) setActive((to + shown.length) % shown.length) }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Home' && !inInput) move(0)
    else if (event.key === 'End' && !inInput) move(shown.length - 1)
    else if (event.key === 'Enter') { event.preventDefault(); if (at >= 0) pick(shown[at]!) }
    else if (event.key === 'Escape') { event.preventDefault(); close(true) }
    else if (event.key === 'Tab') setOpen(false)
  }
  // The focus went somewhere else on the page (a press on the list itself moves it nowhere, so that stays open).
  const onBlur = (event: FocusEvent<HTMLElement>) => { const to = event.relatedTarget as Node | null; if (to && !root.current?.contains(to)) setOpen(false) }
  // Selecting the name to copy it is a drag that ends in a click: that click leaves the list as it was.
  const onTrigger = (event: MouseEvent<HTMLElement>) => {
    const selected = window.getSelection?.()
    if (selected && !selected.isCollapsed && event.currentTarget.contains(selected.anchorNode)) return
    if (open) close(false); else show()
  }

  return {
    open, query, shown, active: at, filtering,
    rootProps: { ref: root, onKeyDown, onBlur },
    triggerProps: { ref: (element: HTMLElement | null) => { trigger.current = element }, role: 'button' as const, tabIndex: 0, 'aria-haspopup': 'listbox' as const, 'aria-expanded': open, 'aria-controls': open ? listId : undefined, onClick: onTrigger },
    inputProps: {
      ref: input, value: query, role: 'combobox' as const, 'aria-expanded': true, 'aria-controls': listId, 'aria-autocomplete': 'list' as const,
      'aria-activedescendant': at >= 0 ? optionId(at) : undefined,
      onChange: (event: { target: { value: string } }) => { setQuery(event.target.value); setActive(0) },
    },
    listProps: { ref: list, id: listId, role: 'listbox' as const, tabIndex: -1, 'aria-activedescendant': !filtering && at >= 0 ? optionId(at) : undefined },
    optionProps: (item: T, index: number) => ({
      id: optionId(index), role: 'option' as const, 'aria-selected': key(item) === current, 'data-active': index === at ? '' : undefined,
      onPointerMove: () => { if (index !== at) setActive(index) },
      onClick: () => pick(item),
    }),
  }
}
