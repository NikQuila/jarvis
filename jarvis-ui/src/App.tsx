import { useCallback, useEffect, useRef, useState } from 'react'
import { Scene } from './scene/Scene'
import { useStore } from './store'
import { Hud, type Line } from './nik/Hud'
import { ask, getBriefing, getState, initKey, setKey, type JarvisState } from './nik/api'
import { canListen, listen, listenFor, preload, speak, stopSpeaking, unlockAudio } from './nik/voice'
import { openSatellites, prepareScreens, resetSatellites, setCues } from './nik/screens'
import { music } from './nik/music'
import { FAKE_HOUR } from './nik/time'
import './nik/nik.css'


// Waking him: while he waits, anything you say wakes him (your JARVIS_WAKE_LINE, or whatever you like). Space too.
const WAKE = /\S{2,}/
// Through the mic button, these ask for the briefing too (not plain "JARVIS", which starts any request).
const BRIEFING_ASK = /wake|weik|walk|wokin|g[uü]e[iy] ?cap|despierta|lev[aá]nta|giorno|c[oó]mo (se viene|viene|va|estoy|est[aá]) (el|en el|mi) d[ií]a/i

export default function App() {
  const phase = useStore((s) => s.phase)
  const setPhase = useStore((s) => s.setPhase)
  const [key, setKeyState] = useState<string | null>(() => initKey())
  const [data, setData] = useState<JarvisState | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [awaitingWake, setAwaitingWake] = useState(true) // until the wake line (or Space) starts the briefing
  const briefing = useRef<Promise<string> | null>(null)
  const stopWake = useRef<(() => void) | null>(null)
  const awaitingRef = useRef(true)
  const dataRef = useRef<JarvisState | null>(null)
  dataRef.current = data // same as awaitingWake, readable from the mic callbacks without re-subscribing
  const stopRef = useRef<(() => void) | null>(null)

  const refresh = useCallback(() => {
    getState().then((s) => { setData(s); setError(null) })
      .catch((e) => setError(e.message === 'unauthorized' ? 'Clave inválida' : 'Sin conexión con el servidor'))
  }, [])

  // Straight to the HUD: no start screen. The first click or key anywhere unlocks audio (a browser rule).
  useEffect(() => {
    setPhase('dormant')
    prepareScreens()
    const unlock = () => { unlockAudio(); speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); music.ambient(true) }
    addEventListener('pointerdown', unlock, { capture: true, once: true })
    addEventListener('keydown', unlock, { capture: true, once: true })
    return () => { removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true) }
  }, [setPhase])

  // The work track rises while Jarvis is thinking or running a tool.
  useEffect(() => { music.work(phase === 'thinking' || phase === 'tooling') }, [phase])

  // Which page each satellite screen opens for each topic (JARVIS_SCREENS on the server).
  useEffect(() => { if (data?.ui?.screens) setCues(data.ui.screens) }, [data?.ui?.screens])

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

  // The briefing takes ~20-30 s to write, so it starts as soon as the page opens.
  useEffect(() => {
    if (!key || briefing.current) return
    briefing.current = getBriefing(FAKE_HOUR).then(({ text }) => { preload(text); return text })
      .catch(() => 'Buongiorno. Todos los sistemas en línea, pero no pude armar el reporte del día.')
  }, [key])

  // The day's briefing, out loud. Also what "Wake up" / "¿cómo se viene el día?" get when said through the mic.
  const playBriefing = useCallback(async (heard?: string) => {
    awaitingRef.current = false
    stopWake.current?.()
    stopWake.current = null
    setAwaitingWake(false)
    resetSatellites()
    stopSpeaking()
    setInterim('')
    // What speech recognition hears is rough: show the configured wake line instead when it sounds like it.
    const line = dataRef.current?.ui?.wakeLine || 'Buongiorno, JARVIS.'
    setLines(heard ? [{ who: 'user', text: /giorno|yorno|jorno|bon|buen|jarvis/i.test(heard) ? line : heard }] : [])
    music.boot()
    setPhase('thinking')
    await say(await (briefing.current ?? Promise.resolve('Buongiorno.')))
  }, [setPhase, say])

  const wake = useCallback((heard?: string) => { if (awaitingRef.current) playBriefing(heard) }, [playBriefing])

  // Listening for the wake needs the mic permission already granted for this site (Chrome remembers it).
  useEffect(() => {
    if (!key || !awaitingWake) return
    stopWake.current = listenFor(WAKE, wake)
    return () => { stopWake.current?.(); stopWake.current = null }
  }, [key, awaitingWake, wake])

  const send = useCallback(async (text: string) => {
    text = text.trim()
    if (!text) return
    if (awaitingRef.current || (BRIEFING_ASK.test(text) && text.split(/\s+/).length <= 8)) return playBriefing(text) // the first thing he says, or "¿cómo se viene el día?"
    awaitingRef.current = false
    setAwaitingWake(false) // talking to him directly also ends the wait for the wake line
    stopSpeaking()
    setInterim('')
    setLines((l) => [...l.slice(-6), { who: 'user', text }])
    setPhase('thinking')
    try {
      const { reply } = await ask(text, FAKE_HOUR)
      refresh()
      // The server re-reads the calendar in the background after a calendar change (~30-60 s): poll a few times.
      for (const ms of [20_000, 45_000, 75_000]) setTimeout(refresh, ms)
      await say(reply)
    } catch (e: any) {
      setPhase('dormant')
      setLines((l) => [...l, { who: 'jarvis', text: e.message === 'unauthorized' ? 'Clave inválida.' : 'Perdí la conexión con el servidor.' }])
    }
  }, [setPhase, say, refresh, playBriefing])

  const toggleMic = useCallback(async () => {
    if (phase === 'listening') { stopRef.current?.(); return }
    if (phase === 'thinking') return
    stopWake.current?.() // one recognizer at a time
    awaitingRef.current = false
    setAwaitingWake(false)
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
      // S = (re)open the satellite screens, B = back to their background
      if (e.code === 'KeyS' && (e.target as HTMLElement)?.tagName !== 'INPUT') { openSatellites(); return }
      if (e.code === 'KeyB' && (e.target as HTMLElement)?.tagName !== 'INPUT') { resetSatellites(); return }
      if (e.code === 'KeyF' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        if (document.fullscreenElement) document.exitFullscreen()
        else document.documentElement.requestFullscreen?.()
        return
      }
      if (e.code === 'Space' && awaitingWake && (e.target as HTMLElement)?.tagName !== 'INPUT') { e.preventDefault(); wake(dataRef.current?.ui?.wakeLine || 'Buongiorno, JARVIS.'); return }
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'INPUT' && phase !== 'offline' && phase !== 'boot') {
        e.preventDefault()
        toggleMic()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleMic, phase, awaitingWake, wake])

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
      {phase !== 'offline' && phase !== 'boot' && (
        <Hud data={data} lines={lines} interim={interim} phase={phase} error={error}
          onMic={toggleMic} onSend={send} canListen={canListen} />
      )}
    </>
  )
}
