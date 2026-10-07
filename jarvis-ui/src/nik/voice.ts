// Spanish voice in and out with the browser's own engines (Web Speech API), plus a level signal for the reactor.
import { useStore } from '../store'

type SR = {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null
  start(): void; stop(): void; abort(): void
}
const Recognition: (new () => SR) | undefined =
  (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
export const canListen = !!Recognition
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)

let level = 0
let levelTimer: number | null = null
function pumpLevel(fn: () => number) {
  stopLevel()
  levelTimer = window.setInterval(() => {
    level = level * 0.6 + fn() * 0.4
    useStore.getState().setLevel(level)
  }, 50)
}
function stopLevel() {
  if (levelTimer) clearInterval(levelTimer)
  levelTimer = null
  useStore.getState().setLevel(0)
}

/** Mic level from a real analyser on desktop; iOS refuses mic + recognition together, so it gets a gentle fake. */
async function micLevel(): Promise<() => void> {
  if (IOS || !navigator.mediaDevices?.getUserMedia) {
    pumpLevel(() => 0.25 + Math.random() * 0.25)
    return stopLevel
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx = new AudioContext()
    const an = ctx.createAnalyser()
    an.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(an)
    const buf = new Uint8Array(an.fftSize)
    pumpLevel(() => {
      an.getByteTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += ((v - 128) / 128) ** 2
      return Math.min(1, Math.sqrt(sum / buf.length) * 6)
    })
    return () => { stopLevel(); stream.getTracks().forEach((t) => t.stop()); ctx.close() }
  } catch {
    pumpLevel(() => 0.3)
    return stopLevel
  }
}

/** One utterance. Resolves with the final transcript ('' if nothing was heard). */
export function listen(onInterim: (t: string) => void): { done: Promise<string>; stop: () => void } {
  if (!Recognition) return { done: Promise.resolve(''), stop: () => {} }
  const rec = new Recognition()
  rec.lang = 'es-CL'
  rec.interimResults = true
  rec.continuous = false
  let finalText = ''
  let release: () => void = () => {}
  micLevel().then((r) => (release = r))
  const done = new Promise<string>((resolve) => {
    rec.onresult = (e: any) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t
        else interim += t
      }
      onInterim((finalText + ' ' + interim).trim())
    }
    rec.onerror = () => {}
    rec.onend = () => { release(); resolve(finalText.trim()) }
  })
  rec.start()
  return { done, stop: () => rec.stop() }
}

let voice: SpeechSynthesisVoice | null = null
let italian: SpeechSynthesisVoice | null = null
function pickVoice() {
  const voices = speechSynthesis.getVoices()
  const all = voices.filter((v) => v.lang.toLowerCase().startsWith('es'))
  const rank = (v: SpeechSynthesisVoice) =>
    (/google/i.test(v.name) ? 3 : 0) + (/(jorge|diego|juan|andr[eé]s|enrique|pablo)/i.test(v.name) ? 2 : 0) +
    (/es-(cl|mx|us|419)/i.test(v.lang) ? 1 : 0) + (v.localService ? 0 : 1)
  voice = all.sort((a, b) => rank(b) - rank(a))[0] ?? null
  // A male Italian voice for the boot line, if the system has one (macOS: Luca; Chrome: Google italiano).
  const it = voices.filter((v) => v.lang.toLowerCase().startsWith('it'))
  italian = it.find((v) => /luca|diego|giorgio|google/i.test(v.name)) ?? it[0] ?? null
}
if ('speechSynthesis' in window) {
  pickVoice()
  speechSynthesis.onvoiceschanged = pickVoice
}

/** Speaks and drives the reactor with a speech-like envelope (the browser doesn't expose TTS audio). */
export function speak(text: string, lang: 'es' | 'it' = 'es', cancel = true): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve()
    if (cancel) speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const v = lang === 'it' ? italian ?? voice : voice
    if (v) u.voice = v
    u.lang = v?.lang ?? (lang === 'it' ? 'it-IT' : 'es-CL')
    u.rate = lang === 'it' ? 1.08 : 1.03
    u.pitch = lang === 'it' ? 1.0 : 0.92
    let t = 0
    pumpLevel(() => { t += 1; return 0.35 + 0.35 * Math.abs(Math.sin(t * 0.55)) * Math.random() + 0.15 * Math.random() })
    const end = () => { stopLevel(); resolve() }
    u.onend = end
    u.onerror = end
    speechSynthesis.speak(u)
    // iOS sometimes never fires onend.
    setTimeout(() => { if (!speechSynthesis.speaking) end() }, Math.max(4000, text.length * 90))
  })
}
export const stopSpeaking = () => { speechSynthesis.cancel(); stopLevel() }
