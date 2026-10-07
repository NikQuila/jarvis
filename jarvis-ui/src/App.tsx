import { useCallback, useEffect, useRef, useState } from 'react'
import { Scene } from './scene/Scene'
import { Boot } from './ui/Boot'
import { useStore } from './store'
import { Hud, type Line } from './nik/Hud'
import { ask, getState, initKey, setKey, type JarvisState } from './nik/api'
import { canListen, listen, speak, stopSpeaking } from './nik/voice'
import { music } from './nik/music'
import './nik/nik.css'

const BOOT_MS = 6400

/** The boot line: JARVIS_BOOT_LINES="morning|evening" on the server (Italian by default). Empty = no boot line. */
function bootLine(s: JarvisState | null) {
  const [morning = '', evening = morning] = s?.ui?.bootLines ?? ['Buongiorno.', 'Buonasera.']
  return new Date().getHours() < 13 ? morning : evening
}

function greetingFor(s: JarvisState | null, owner: string) {
  const parts = [`Todos los sistemas en línea, ${owner}.`]
  const w = s?.whoop
  if (w?.recovery != null) parts.push(`Recovery al ${Math.round(w.recovery)} por ciento${w.sleepHours ? `, dormiste ${String(w.sleepHours).replace('.', ',')} horas` : ''}.`)
  const next = s?.agenda.find((e) => new Date(e.start).getTime() > Date.now() - 10 * 60_000)
  if (next) parts.push(`Lo próximo: ${next.title.replace(/[^\p{L}\p{N}\s:,.()-]/gu, '').trim()}, a las ${next.time}.`)
  return parts.join(' ')
}

export default function App() {
  const phase = useStore((s) => s.phase)
  const setPhase = useStore((s) => s.setPhase)
  const [key, setKeyState] = useState<string | null>(() => initKey())
  const [data, setData] = useState<JarvisState | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const dataRef = useRef<JarvisState | null>(null)
  dataRef.current = data

  const refresh = useCallback(() => {
    getState().then((s) => { setData(s); setError(null) })
      .catch((e) => setError(e.message === 'unauthorized' ? 'Clave inválida' : 'Sin conexión con el servidor'))
  }, [])

  // ?skip=1 jumps straight to the HUD (screenshots / quick reloads); audio still needs a tap to unlock.
  useEffect(() => {
    if (new URLSearchParams(location.search).has('skip')) setPhase('dormant')
  }, [setPhase])

  // The work track rises while Jarvis is thinking or running a tool.
  useEffect(() => { music.work(phase === 'thinking' || phase === 'tooling') }, [phase])

  useEffect(() => {
    if (!key) return
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => clearInterval(id)
  }, [key, refresh])

  const say = useCallback(async (text: string) => {
    setLines((l) => [...l.slice(-6), { who: 'jarvis', text }])
    setPhase('speaking')
    await speak(text)
    setPhase('dormant')
  }, [setPhase])

  const power = useCallback(() => {
    // The tap unlocks audio on iOS: speak something silent right away.
    speechSynthesis.speak(new SpeechSynthesisUtterance(' '))
    music.boot()
    setPhase('boot')
    setTimeout(async () => {
      setPhase('dormant')
      music.ambient(true)
      const line = bootLine(dataRef.current)
      if (line) {
        setLines((l) => [...l.slice(-6), { who: 'jarvis', text: line }])
        setPhase('speaking')
        await speak(line, dataRef.current?.ui?.bootLang === 'es' ? 'es' : 'it')
      }
      await say(greetingFor(dataRef.current, dataRef.current?.owner || 'jefe'))
    }, BOOT_MS)
  }, [setPhase, say])

  const send = useCallback(async (text: string) => {
    text = text.trim()
    if (!text) return
    stopSpeaking()
    setInterim('')
    setLines((l) => [...l.slice(-6), { who: 'user', text }])
    setPhase('thinking')
    try {
      const { reply } = await ask(text)
      refresh()
      // The server re-reads the calendar in the background after a calendar change (~30-60 s): poll a few times.
      for (const ms of [20_000, 45_000, 75_000]) setTimeout(refresh, ms)
      await say(reply)
    } catch (e: any) {
      setPhase('dormant')
      setLines((l) => [...l, { who: 'jarvis', text: e.message === 'unauthorized' ? 'Clave inválida.' : 'Perdí la conexión con el servidor.' }])
    }
  }, [setPhase, say, refresh])

  const toggleMic = useCallback(async () => {
    if (phase === 'listening') { stopRef.current?.(); return }
    if (phase === 'thinking') return
    stopSpeaking()
    setPhase('listening')
    const { done, stop } = listen(setInterim)
    stopRef.current = stop
    const text = await done
    stopRef.current = null
    if (text) send(text)
    else { setInterim(''); setPhase('dormant') }
  }, [phase, setPhase, send])

  // Space bar = push to talk on the Mac; F = full screen (no browser bar, for recording).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyF' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        if (document.fullscreenElement) document.exitFullscreen()
        else document.documentElement.requestFullscreen?.()
        return
      }
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'INPUT' && phase !== 'offline' && phase !== 'boot') {
        e.preventDefault()
        toggleMic()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleMic, phase])

  if (!key) {
    return (
      <div className="nik-lock">
        <div className="nik-brand">J.A.R.V.I.S.</div>
        <form onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('k') as string; setKey(v); setKeyState(v) }}>
          <input name="k" type="password" placeholder="CLAVE DE ACCESO" autoFocus />
        </form>
      </div>
    )
  }

  return (
    <>
      <Scene />
      <div className="nik-grid" />
      <Boot />
      {phase === 'offline' && (
        <button className="nik-power" onClick={power}>
          <span className="nik-brand">J.A.R.V.I.S.</span>
          <span className="nik-power-hint">TOCA PARA INICIAR</span>
        </button>
      )}
      {phase !== 'offline' && phase !== 'boot' && (
        <Hud data={data} lines={lines} interim={interim} phase={phase} error={error}
          onMic={toggleMic} onSend={send} canListen={canListen} />
      )}
    </>
  )
}
