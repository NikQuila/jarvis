import { useCallback, useEffect, useRef, useState } from 'react'
import { Scene } from './scene/Scene'
import { Boot } from './ui/Boot'
import { useStore } from './store'
import { Hud, type Line } from './nik/Hud'
import { ask, getBriefing, getState, initKey, setKey, type JarvisState } from './nik/api'
import { canListen, listen, listenFor, preload, speak, stopSpeaking, unlockAudio } from './nik/voice'
import { music } from './nik/music'
import './nik/nik.css'

const BOOT_MS = 6400

// The wake line (JARVIS_WAKE_LINE on the server). You say it; JARVIS powers up and answers with the day's briefing.
// Matching is loose on purpose: speech recognition hears "buongiorno" as anything from "bon" to "yorno".
const WAKE = /giorno|yorno|jorno|journo|\bbu?on\b|jarvis|yarvis|despierta|c[oó]mo se viene/i

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
  const [standby, setStandby] = useState(false)
  const briefing = useRef<Promise<string> | null>(null)
  const stopWake = useRef<(() => void) | null>(null)

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

  // The briefing takes ~20-30 s to write (and to voice), so it starts as soon as the page opens, before the tap.
  useEffect(() => {
    if (!key || briefing.current) return
    briefing.current = getBriefing().then(({ text }) => { preload(text); return text })
      .catch(() => 'Buongiorno. Todos los sistemas en línea, pero no pude armar el reporte del día.')
  }, [key])

  // First tap: unlock audio and the mic, then wait in the dark for the wake line.
  const power = useCallback(() => {
    unlockAudio()
    speechSynthesis.speak(new SpeechSynthesisUtterance(' '))
    setStandby(true)
  }, [])

  // The wake line (or a tap / Space as a fallback): the reactor boots, then the briefing.
  const wake = useCallback(() => {
    stopWake.current?.()
    stopWake.current = null
    setStandby(false)
    setLines([{ who: 'user', text: dataRef.current?.ui?.wakeLine || 'Buongiorno, JARVIS. ¿Cómo se viene el día?' }])
    music.boot()
    setPhase('boot')
    setTimeout(async () => {
      setPhase('dormant')
      music.ambient(true)
      await say(await (briefing.current ?? Promise.resolve('Buongiorno.')))
    }, BOOT_MS)
  }, [setPhase, say])

  useEffect(() => {
    if (!standby) return
    stopWake.current = listenFor(WAKE, wake)
    return () => { stopWake.current?.(); stopWake.current = null }
  }, [standby, wake])

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
      if (e.code === 'Space' && standby) { e.preventDefault(); wake(); return }
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'INPUT' && phase !== 'offline' && phase !== 'boot') {
        e.preventDefault()
        toggleMic()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleMic, phase, standby, wake])

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
      {phase === 'offline' && standby && (
        <button className="nik-standby" onClick={wake} aria-label="Despertar a JARVIS"><i /></button>
      )}
      {phase === 'offline' && !standby && (
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
