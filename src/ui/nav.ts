/**
 * The board the 板子 button in the top bar opens from another page: the one last looked at, so a person does not have
 * to find it again. On a board's page the button goes back to the overview, which the frontend itself knows; pressing it
 * twice henceforth toggles the board and the overview, and another tab goes straight to the last board.
 *
 * Each frontend keeps its own memory and builds its own address: this layer holds the memory only, and its test needs
 * no page.
 */
const remembered = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }

/** The board last looked at (its page or its console), or null when this browser has not looked at one. */
export function lastBoard(key: string): string | null { return remembered(key) }

/** Record that `board` was opened: the next press of the 板子 button elsewhere returns to it. */
export function visitBoard(key: string, board: string): void { try { localStorage.setItem(key, board) } catch {} }

/** Forget a board that is gone, so the button does not keep offering it. */
export function forgetBoard(key: string, board: string): void { if (remembered(key) === board) { try { localStorage.removeItem(key) } catch {} } }
