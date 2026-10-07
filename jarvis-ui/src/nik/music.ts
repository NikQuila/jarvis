// Background music for the HUD: a swell on boot, a low bed underneath, and a track that rises while Jarvis works.
// Files live in public/audio/ (Kevin MacLeod, CC BY 4.0, see CREDITS.md). Drop in any MP3 with the same name to
// replace one. M mutes; the choice is remembered.
const BASE = `${import.meta.env.BASE_URL}audio/`
const LEVEL = { boot: 0.55, ambient: 0.12, work: 0.22 }
type Name = keyof typeof LEVEL

const tracks: Partial<Record<Name, HTMLAudioElement>> = {}
const wanted: Record<Name, boolean> = { boot: false, ambient: false, work: false }
const fades = new Map<HTMLAudioElement, number>()
let muted = localStorage.getItem('jarvis-muted') === '1'

function track(name: Name) {
  let a = tracks[name]
  if (!a) {
    const file = name === 'boot' ? 'boot-music' : name
    a = tracks[name] = new Audio(`${BASE}${file}.mp3`)
    a.loop = name !== 'boot'
    a.volume = 0
  }
  return a
}

function fade(a: HTMLAudioElement, to: number, ms = 1200) {
  clearInterval(fades.get(a))
  if (to > 0 && a.paused) a.play().catch(() => {})
  const from = a.volume, t0 = performance.now()
  fades.set(a, window.setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms)
    a.volume = from + (to - from) * k
    if (k === 1) { clearInterval(fades.get(a)); if (to === 0) a.pause() }
  }, 40))
}

function set(name: Name, on: boolean, ms?: number) {
  wanted[name] = on
  fade(track(name), on && !muted ? LEVEL[name] : 0, ms)
}

export const music = {
  get muted() { return muted },
  /** Call from the tap that starts JARVIS (browsers only allow audio after a user gesture). */
  boot() {
    const a = track('boot')
    a.currentTime = 0
    set('boot', true, 300)
    a.onended = () => { wanted.boot = false }
  },
  ambient: (on: boolean) => set('ambient', on, 3000),
  work: (on: boolean) => set('work', on, on ? 1500 : 2500),
  toggle() {
    muted = !muted
    localStorage.setItem('jarvis-muted', muted ? '1' : '0')
    for (const n of Object.keys(wanted) as Name[]) if (tracks[n]) fade(tracks[n]!, wanted[n] && !muted ? LEVEL[n] : 0, 400)
    return muted
  },
}
