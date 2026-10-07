// Satellite screens: the other monitors around the HUD. They idle on bg.html (the HUD's world continued) and, while
// JARVIS talks, open the real page behind each sentence (WHOOP, RevenueCat, the calendar…), alternating
// screens like a cascade. Needs two one-time permissions for the site: "Pop-ups" and "Window management".

type Cue = { match: RegExp; url: string }
// Defaults; set your own with JARVIS_SCREENS on the server: [{"match":"regex","url":"https://…"}, …]
let CUES: Cue[] = [
  { match: /dorm|recuper|sueño|whoop|\bhrv\b/i, url: 'https://app.whoop.com/' },
  { match: /suscriptor|\bmrr\b|revenue|trials?\b|la está rompiendo/i, url: 'https://app.revenuecat.com/' },
  { match: /agenda|reuni|almuerzo|cena|cierre|bloque|a las (una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)/i, url: 'https://calendar.google.com/calendar/r/day' },
]
export function setCues(list: { match: string; url: string }[]) {
  const parsed = list.flatMap((c) => { try { return [{ match: new RegExp(c.match, 'i'), url: c.url }] } catch { return [] } })
  if (parsed.length) CUES = parsed
}

const BG = new URL('bg.html', location.href).href.split('?')[0]
type Sat = { win: Window | null; spec: string; bg: string; showing: string }
let sats: Sat[] = []
let next = 0

// window.open has to run right inside the click (Chrome blocks it after an await), so the screen layout is read
// beforehand whenever the permission was already granted.
let details: any = null
let notify: (msg: string) => void = () => {}
export const onScreensNote = (fn: (msg: string) => void) => { notify = fn }

export async function prepareScreens() {
  try {
    const st = await navigator.permissions.query({ name: 'window-management' as PermissionName })
    if (st.state === 'granted') details = await (window as any).getScreenDetails()
  } catch { /* not Chrome, or no API */ }
}

/** Opens (or reopens) one window per other screen, on the background. Must be called from a click or key press. */
export function openSatellites() {
  if ((screen as any).isExtended === false) return notify('Solo veo una pantalla conectada')
  if (!('getScreenDetails' in window)) return notify('Este navegador no puede abrir ventanas en otras pantallas: usa Chrome')
  if (!details) {
    // First time: Chrome asks "Administrar ventanas en todas tus pantallas". The click is spent on that question.
    ;(window as any).getScreenDetails()
      .then((d: any) => { details = d; notify('Permiso listo. Toca ⧉ PANTALLAS otra vez') })
      .catch(() => notify('Sin permiso de pantallas: ícono a la izquierda de la dirección → Administración de ventanas → Permitir'))
    return
  }
  const cur = details.currentScreen
  const same = (a: any, b: any) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
  const others = details.screens.filter((x: any) => !same(x, cur))
    .map((x: any) => ({ left: x.availLeft, top: x.availTop, width: x.availWidth, height: x.availHeight }))
    .sort((a: any, b: any) => a.left - b.left || a.top - b.top) // left/upper first: the cascade reads left to right
  if (!others.length) return notify('Solo veo una pantalla conectada')
  const cx = cur.availLeft + cur.availWidth / 2, cy = cur.availTop + cur.availHeight / 2
  let blocked = 0
  sats = others.map((x: any, i: number) => {
    const dx = cx - (x.left + x.width / 2), dy = cy - (x.top + x.height / 2), n = Math.hypot(dx, dy) || 1
    const bg = `${BG}?n=0${i + 2}&dx=${(dx / n).toFixed(2)}&dy=${(dy / n).toFixed(2)}`
    const spec = `popup=yes,left=${x.left},top=${x.top},width=${x.width},height=${x.height}`
    const old = sats[i]?.win
    let win: Window | null
    if (old && !old.closed) { old.location.href = bg; old.moveTo(x.left, x.top); old.resizeTo(x.width, x.height); win = old }
    else win = window.open(bg, `jarvis-sat-${i}`, spec)
    if (!win) blocked++
    return { win, spec, bg, showing: bg }
  })
  next = 0
  window.focus() // keep the keyboard (Space) on the HUD
  notify(blocked
    ? `Chrome bloqueó ${blocked} ventana${blocked > 1 ? 's' : ''}: ícono a la derecha de la dirección → Permitir ventanas emergentes, y toca ⧉ otra vez`
    : `${others.length} pantalla${others.length > 1 ? 's' : ''} conectada${others.length > 1 ? 's' : ''}`)
}

function show(url: string) {
  const live = sats.filter((s) => s.win && !s.win.closed)
  if (!live.length || live.some((s) => s.showing === url)) return
  const s = live[next % live.length]
  next++
  s.win!.location.href = url // allowed cross-origin, and it doesn't steal focus
  s.showing = url
}

/** Called for every sentence JARVIS starts saying: opens the page that goes with it, if any. */
export function cue(sentence: string) {
  const c = CUES.find((x) => x.match.test(sentence))
  if (c) show(c.url)
}

/** Back to the background on every satellite (B on the HUD, or before a new take). */
export function resetSatellites() {
  for (const s of sats) if (s.win && !s.win.closed) { s.win.location.href = s.bg; s.showing = s.bg }
  next = 0
}
