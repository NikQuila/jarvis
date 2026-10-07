// Talks to the assistant's server (same origin in production, VITE_API in dev).
const BASE = (import.meta.env.VITE_API as string | undefined) ?? ''

export type AgendaItem = {
  time: string; start: string; end?: string; title: string
  description?: string; calendar?: string; link?: string; location?: string; meet?: string; attendees?: string[]
}

export type JarvisState = {
  now: string
  owner?: string
  agenda: AgendaItem[]
  whoop?: { recovery?: number; hrv?: number; rhr?: number; sleepHours?: number; sleepPerf?: number } | null
  companies?: { name: string; label: string; value: string; note?: string }[]
  revenue?: { revenue28d?: number; mrr?: number; activeSubs?: number; trials?: number; newCustomers28d?: number } | null
  /** Personal bits (boot line, panel titles, calendar names), set with env vars on the server. */
  ui?: { bootLines?: string[]; bootLang?: string; revenueTitle?: string; calendarLabels?: Record<string, string> }
  demo?: boolean
}

const KEY = 'jarvis-key'
export function initKey(): string | null {
  const url = new URL(location.href)
  const k = url.searchParams.get('k')
  if (k) {
    localStorage.setItem(KEY, k)
    url.searchParams.delete('k')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
  return localStorage.getItem(KEY)
}
export const setKey = (k: string) => localStorage.setItem(KEY, k)

async function call(path: string, init?: RequestInit) {
  const r = await fetch(`${BASE}/jarvis/api/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Jarvis-Key': localStorage.getItem(KEY) ?? '', ...(init?.headers ?? {}) },
  })
  if (r.status === 401) throw new Error('unauthorized')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export const getState = (): Promise<JarvisState> => call('state')
export const ask = (text: string): Promise<{ reply: string }> =>
  call('ask', { method: 'POST', body: JSON.stringify({ text }) })
