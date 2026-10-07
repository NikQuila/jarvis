import { useEffect, useState } from 'react'
import type { AgendaItem, JarvisState } from './api'
import type { Phase } from '../store'
import { speechProgress } from './voice'
import { nowMs } from './time'
import { cue, onScreensNote, openSatellites } from './screens'
import { music } from './music'

export type Line = { who: 'user' | 'jarvis'; text: string }

const PHASE_LABEL: Partial<Record<Phase, string>> = {
  dormant: 'EN ESPERA', listening: 'ESCUCHANDO', thinking: 'PROCESANDO', tooling: 'EJECUTANDO', speaking: 'HABLANDO',
}
const fmtMoney = (n?: number) => (n == null ? '—' : `$${Math.round(n).toLocaleString('es-CL')}`)
const zone = (r?: number) => (r == null ? 'none' : r >= 67 ? 'green' : r >= 34 ? 'yellow' : 'red')

function Clock() {
  const [now, setNow] = useState(new Date(nowMs()))
  useEffect(() => { const id = setInterval(() => setNow(new Date(nowMs())), 1000); return () => clearInterval(id) }, [])
  return (
    <div className="nik-clock">
      <span className="nik-time">{now.toLocaleTimeString('es-CL', { hour12: false })}</span>
      <span className="nik-date">{now.toLocaleDateString('es-CL', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}</span>
    </div>
  )
}

function Ring({ value }: { value?: number }) {
  const r = 52, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <svg viewBox="0 0 128 128" className={`nik-ring nik-zone-${zone(value)}`}>
      <circle cx="64" cy="64" r={r} className="nik-ring-bg" />
      <circle cx="64" cy="64" r={r} className="nik-ring-fg" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 64 64)" />
      {Array.from({ length: 40 }).map((_, i) => (
        <line key={i} x1="64" y1="4" x2="64" y2={i % 5 ? 8 : 11} className="nik-ring-tick" transform={`rotate(${i * 9} 64 64)`} />
      ))}
      <text x="64" y="62" className="nik-ring-val">{value == null ? '--' : Math.round(v)}<tspan className="nik-ring-pct">%</tspan></text>
      <text x="64" y="82" className="nik-ring-label">RECOVERY</text>
    </svg>
  )
}

function Bio({ w }: { w: JarvisState['whoop'] }) {
  return (
    <section className="nik-panel nik-bio">
      <header>BIOMETRÍA <i>WHOOP</i></header>
      <Ring value={w?.recovery} />
      <dl>
        <div><dt>HRV</dt><dd>{w?.hrv ?? '--'}<small>ms</small></dd></div>
        <div><dt>FC REPOSO</dt><dd>{w?.rhr ?? '--'}<small>bpm</small></dd></div>
        <div><dt>SUEÑO</dt><dd>{w?.sleepHours ?? '--'}<small>h</small></dd></div>
        <div><dt>RENDIMIENTO</dt><dd>{w?.sleepPerf ?? '--'}<small>%</small></dd></div>
      </dl>
    </section>
  )
}

const untilLabel = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 60 ? `EN ${m} MIN` : `EN ${Math.floor(m / 60)}H ${String(m % 60).padStart(2, '0')}M`
}

/** Past blocks fade; the one happening now says AHORA; the next one shows a countdown instead of looking current. */
function Agenda({ items, onOpen }: { items: JarvisState['agenda']; onOpen: (e: AgendaItem) => void }) {
  const [now, setNow] = useState(nowMs())
  useEffect(() => { const id = setInterval(() => setNow(nowMs()), 30_000); return () => clearInterval(id) }, [])
  const startOf = (e: (typeof items)[number]) => new Date(e.start).getTime()
  const endOf = (e: (typeof items)[number], i: number) =>
    e.end ? new Date(e.end).getTime() : i + 1 < items.length ? startOf(items[i + 1]) : startOf(e) + 60 * 60_000
  const nowIdx = items.findIndex((e, i) => startOf(e) <= now && now < endOf(e, i))
  const nextIdx = items.findIndex((e) => startOf(e) > now)
  return (
    <section className="nik-panel nik-agenda">
      <header>AGENDA <i>{nowIdx === -1 && nextIdx !== -1 ? 'LIBRE AHORA' : 'HOY'}</i></header>
      <ol>
        {items.length === 0 && <li className="nik-empty">Sin eventos</li>}
        {items.map((e, i) => {
          const state = i === nowIdx ? 'now' : i === nextIdx ? 'next' : endOf(e, i) <= now ? 'past' : ''
          return (
            <li key={i} className={state} role="button" tabIndex={0} onClick={() => onOpen(e)}
              onKeyDown={(k) => { if (k.key === 'Enter') onOpen(e) }}>
              <time>{e.time}</time>
              <span>{e.title}{state === 'now' && <em>AHORA</em>}{state === 'next' && <em>{untilLabel(startOf(e) - now)}</em>}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

// JARVIS_CALENDAR_LABELS on the server: {"@gmail.com":"PERSONAL","@acme.com":"ACME"} (matched by suffix).
const calendarLabel = (labels: Record<string, string> | undefined, c?: string) =>
  !c ? '' : Object.entries(labels ?? {}).find(([suffix]) => c.endsWith(suffix))?.[1] ?? 'CALENDARIO'
const hm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false }) : '')
const dur = (a: string, b?: string) => {
  if (!b) return ''
  const m = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000)
  return m < 60 ? `${m} MIN` : `${Math.floor(m / 60)}H${m % 60 ? ` ${String(m % 60).padStart(2, '0')}M` : ''}`
}
// Google opens the event in whichever account is logged in first; authuser points it at the right one.
const calendarUrl = (e: AgendaItem) =>
  !e.link ? '' : e.calendar?.includes('@') && !e.calendar.includes('calendar.google.com')
    ? `${e.link}${e.link.includes('?') ? '&' : '?'}authuser=${encodeURIComponent(e.calendar)}` : e.link
const URL_RE = /(https?:\/\/[^\s)]+)/g
const linkify = (t: string) =>
  t.split(URL_RE).map((part, i) => (i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer">{part.replace(/^https?:\/\//, '').slice(0, 48)}</a> : part))

/** The event's details over the HUD: checklist from the description, people, call link, and a jump to Google Calendar. */
function EventCard({ e, onClose, labels, rec }: { e: AgendaItem; onClose: () => void; labels?: Record<string, string>; rec: boolean }) {
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => { if (k.key === 'Escape') onClose() }
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey)
  }, [onClose])
  const lines = (e.description ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const url = calendarUrl(e)
  return (
    <div className="nik-modal" onClick={onClose}>
      <section className="nik-panel nik-event" onClick={(x) => x.stopPropagation()}>
        <header>EVENTO <i>{calendarLabel(labels, e.calendar)}</i><button className="nik-x" onClick={onClose} aria-label="Cerrar">✕</button></header>
        <h2>{e.title}</h2>
        <div className="nik-event-when">{hm(e.start)} → {hm(e.end)}<small>{dur(e.start, e.end)}</small></div>
        {e.location && !rec && <p className="nik-event-meta"><b>LUGAR</b>{linkify(e.location)}</p>}
        {!!e.attendees?.length && (rec
          ? <p className="nik-event-meta"><b>CON</b>{e.attendees.length} {e.attendees.length === 1 ? 'PERSONA' : 'PERSONAS'}</p>
          : <p className="nik-event-meta"><b>CON</b>{e.attendees.join(' · ')}</p>)}
        {lines.length > 0 && (
          <ul className="nik-event-desc">
            {lines.map((l, i) => {
              const box = /^(\d{1,2}:\d{2})?\s*(☐|☑|✅|- \[[ x]\])\s*/.exec(l)
              if (!box) return <li key={i}>{rec ? l.replace(URL_RE, '🔗') : linkify(l)}</li>
              return <li key={i} className="check">{box[1] && <time>{box[1]}</time>}<span>{linkify(l.slice(box[0].length))}</span></li>
            })}
          </ul>
        )}
        <div className="nik-event-actions">
          {e.meet && !rec && <a className="primary" href={e.meet} target="_blank" rel="noreferrer">UNIRSE A LA LLAMADA</a>}
          {url && !rec && <a href={url} target="_blank" rel="noreferrer">ABRIR EN CALENDAR ↗</a>}
        </div>
      </section>
    </div>
  )
}

function Revenue({ n, title }: { n: JarvisState['revenue']; title?: string }) {
  if (!n) return null
  return (
    <section className="nik-panel nik-kpis">
      <header>{(title || 'REVENUE').toUpperCase()} <i>REVENUECAT</i></header>
      <div className="nik-kpi-main"><span className="nik-amt">{fmtMoney(n?.revenue28d)}</span><small>REVENUE · ÚLTIMOS 28 DÍAS · USD</small></div>
      <dl>
        <div><dt>MRR</dt><dd>{fmtMoney(n?.mrr)}</dd></div>
        <div><dt>SUSCRIPTORES</dt><dd>{n?.activeSubs?.toLocaleString('es-CL') ?? '--'}</dd></div>
        <div><dt>TRIALS</dt><dd>{n?.trials ?? '--'}</dd></div>
      </dl>
    </section>
  )
}

// Not rendered by default: ARR per company (RevenueCat + JARVIS_COMPANIES). Drop <Companies list={...} /> in to show it.
export function Companies({ list }: { list: NonNullable<JarvisState['companies']> }) {
  if (!list.length) return null
  return (
    <section className="nik-panel nik-companies">
      <header>EMPRESAS <i>ARR · USD</i></header>
      <ul>
        {list.map((c) => (
          <li key={c.name}><span>{c.name.toUpperCase()}</span><b>{c.value}</b><small>{c.label}{c.note ? ` · ${c.note}` : ''}</small></li>
        ))}
      </ul>
    </section>
  )
}

/** While JARVIS talks, only the sentence he's saying is shown, big, like film subtitles. */
function Caption({ text }: { text: string }) {
  const sentences = text.match(/[^.!?¿¡]*[¿¡]?[^.!?]+[.!?]+|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [text]
  const [i, setI] = useState(0)
  useEffect(() => {
    const ends: number[] = []
    let acc = 0
    for (const x of sentences) { acc += x.length; ends.push(acc / text.length) }
    const id = setInterval(() => {
      const pr = speechProgress()
      const k = ends.findIndex((e) => pr < e - 0.01)
      setI(k === -1 ? sentences.length - 1 : k)
    }, 120)
    return () => clearInterval(id)
  }, [text])
  useEffect(() => { cue(sentences[i]) }, [i, text]) // the satellite screens open what he's talking about
  return <p className="nik-caption" key={i}>{sentences[i]}</p>
}

export function Hud(p: {
  data: JarvisState | null; lines: Line[]; interim: string; phase: Phase; error: string | null
  onMic: () => void; onSend: (t: string) => void; canListen: boolean
}) {
  const [text, setText] = useState('')
  const [sheet, setSheet] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    let t = 0
    onScreensNote((m) => { setNote(m); clearTimeout(t); t = window.setTimeout(() => setNote(''), 9000) })
  }, [])
  const [open, setOpen] = useState<AgendaItem | null>(null)
  // Recording mode (R or ?rec=1): hides who you meet with, links and amounts, so you can film the screen.
  const [rec, setRec] = useState(() => new URLSearchParams(location.search).has('rec'))
  const [muted, setMuted] = useState(music.muted)
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if ((k.target as HTMLElement)?.tagName === 'INPUT') return
      if (k.code === 'KeyR') setRec((r) => !r)
      if (k.code === 'KeyM') setMuted(music.toggle())
    }
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey)
  }, [])
  const last = p.lines.slice(-3)
  const ui = p.data?.ui
  return (
    <div className={`nik-hud nik-phase-${p.phase} ${rec ? 'nik-rec' : ''}`}>
      <div className="nik-top">
        <div className="nik-brand">J.A.R.V.I.S.</div>
        <div className="nik-status"><b />{PHASE_LABEL[p.phase] ?? ''}{p.data?.demo && <em className="nik-demo"> · DEMO</em>}{rec && <em className="nik-rec-dot"> · ● REC</em>}{p.error && <em> · {p.error}</em>}{note && <span className="nik-note">{note}</span>}</div>
        <div className="nik-topright">
          <button className="nik-fs nik-screens" title="Abrir las otras pantallas (S)" onClick={openSatellites}>⧉ PANTALLAS</button>
          <button className="nik-fs" title="Música (M)" onClick={() => setMuted(music.toggle())}>{muted ? '♪̸' : '♪'}</button>
          <button className="nik-fs" title="Pantalla completa (F)" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())}>⛶</button>
          <Clock />
        </div>
      </div>

      <div className="nik-chips">
        {p.data?.whoop !== undefined && <>
          <span className={`nik-zone-${zone(p.data.whoop?.recovery)}`}>REC {p.data.whoop?.recovery ?? '--'}%</span>
          <span>SUEÑO {p.data.whoop?.sleepHours ?? '--'}h</span>
        </>}
        {p.data?.revenue && <span className="nik-money">REV 28D {fmtMoney(p.data.revenue.revenue28d)}</span>}
        <button onClick={() => setSheet((s) => !s)}>{sheet ? 'CERRAR' : 'AGENDA'}</button>
      </div>

      <aside className="nik-left">{p.data?.whoop !== undefined && <Bio w={p.data.whoop} />}<Revenue n={p.data?.revenue} title={ui?.revenueTitle} /></aside>
      <aside className={`nik-right ${sheet ? 'open' : ''}`}><Agenda items={p.data?.agenda ?? []} onOpen={setOpen} /></aside>
      {open && <EventCard e={open} onClose={() => setOpen(null)} labels={ui?.calendarLabels} rec={rec} />}

      <div className="nik-subs">
        {p.phase === 'speaking' && last.at(-1)?.who === 'jarvis' ? <Caption text={last.at(-1)!.text} /> : last.map((l, i) => (
          <p key={i} className={`nik-line ${l.who}`} style={{ opacity: 0.35 + (0.65 * (i + 1)) / last.length }}>
            <b>{l.who === 'user' ? 'TÚ' : 'JARVIS'}</b> {l.text}
          </p>
        ))}
        {p.interim && <p className="nik-line user interim"><b>TÚ</b> {p.interim}</p>}
      </div>

      <form className="nik-controls" onSubmit={(e) => { e.preventDefault(); p.onSend(text); setText('') }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escríbele a Jarvis…" enterKeyHint="send" />
        {p.canListen && (
          <button type="button" className={`nik-mic ${p.phase === 'listening' ? 'on' : ''}`} onClick={p.onMic} aria-label="Hablar">
            <svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z" /></svg>
          </button>
        )}
      </form>
    </div>
  )
}
