// Spanish voice in and out with the browser's own engines (Web Speech API), plus a level signal for the reactor.
import { useStore } from '../store'
import { getSpeech } from './api'

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
// How far through the current utterance we are (0..1), for subtitles that follow the voice.
let progress = 0
export const speechProgress = () => progress
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
  // macOS "Premium"/"Enhanced" voices (System Settings → Accessibility → Spoken Content) sound far less robotic.
  const rank = (v: SpeechSynthesisVoice) =>
    (/premium|enhanced|mejorada/i.test(v.name) ? 6 : 0) + (/google/i.test(v.name) ? 3 : 0) + (/(jorge|diego|juan|andr[eé]s|enrique|pablo)/i.test(v.name) ? 2 : 0) +
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

// ---- natural voice (ElevenLabs through the server), with the real audio level driving the reactor ----
let ctx: AudioContext | null = null
const player = new Audio()
let analyser: AnalyserNode | null = null
function silentWav() {
  const n = 800, b = new DataView(new ArrayBuffer(44 + n * 2))
  const w = (o: number, t: string) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true)
  b.setUint16(22, 1, true); b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true)
  b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true)
  return URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }))
}
let unlocked = false
let busy = false // a voice clip is loaded or playing: unlocking must not replace it
/** Call inside a click or key press: Chrome and iOS only play audio after a gesture on the page. */
export function unlockAudio() {
  try {
    if (unlocked) { ctx?.resume(); return }
    unlocked = true
    ctx = new AudioContext()
    ctx.resume()
    analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaElementSource(player).connect(analyser)
    analyser.connect(ctx.destination)
    if (!busy) { player.src = silentWav(); player.play().catch(() => {}) }
  } catch { /* old browsers: the system voice still works */ }
}

function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const buf = new Uint8Array(512)
    busy = true
    const done = () => { busy = false; stopLevel(); URL.revokeObjectURL(url); resolve() }
    player.onended = done
    player.onerror = done
    player.src = url
    progress = 0
    pumpLevel(() => {
      if (player.duration > 0) progress = player.currentTime / player.duration
      if (!analyser || player.paused) return player.paused ? 0 : 0.4 + 0.3 * Math.random()
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += ((v - 128) / 128) ** 2
      return Math.min(1, Math.sqrt(sum / buf.length) * 5)
    })
    player.play().catch((e) => {
      // No click on the page yet (e.g. woken by voice right after loading): play on the first click or key.
      if (e?.name !== 'NotAllowedError') return done()
      const go = () => { removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); unlockAudio(); player.play().catch(done) }
      addEventListener('pointerdown', go, true)
      addEventListener('keydown', go, true)
    })
  })
}

const prefetched = new Map<string, Promise<Blob | null>>()
/** Starts generating the audio now so it plays instantly later. */
export function preload(text: string) {
  if (!prefetched.has(text)) prefetched.set(text, getSpeech(text))
}

/** Speaks with the natural voice when the server has one, otherwise with the system voice. */
export async function speak(text: string, lang: 'es' | 'it' = 'es', cancel = true): Promise<void> {
  if (!text) return
  if (cancel) stopSpeaking()
  const blob = await (prefetched.get(text) ?? getSpeech(text, true)) // live replies: the low-latency model
  prefetched.delete(text)
  if (blob) return playBlob(blob)
  return speakSystem(text, lang, false)
}

/** System voice (Web Speech API), with a speech-like envelope since the browser doesn't expose that audio. */
function speakSystem(text: string, lang: 'es' | 'it' = 'es', cancel = true): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve()
    if (cancel) speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const v = lang === 'it' ? italian ?? voice : voice
    if (v) u.voice = v
    u.lang = v?.lang ?? (lang === 'it' ? 'it-IT' : 'es-CL')
    u.rate = lang === 'it' ? 1.08 : 1.03
    u.pitch = lang === 'it' ? 1.0 : 0.92
    // Chrome reports word boundaries for most voices; otherwise estimate from time (~14 chars/s).
    const began = Date.now()
    let byBoundary = false
    progress = 0
    u.onboundary = (e) => { byBoundary = true; progress = e.charIndex / text.length }
    let t = 0
    pumpLevel(() => { if (!byBoundary) progress = Math.min(1, (Date.now() - began) / (text.length * 70)); t += 1; return 0.35 + 0.35 * Math.abs(Math.sin(t * 0.55)) * Math.random() + 0.15 * Math.random() })
    const end = () => { stopLevel(); resolve() }
    u.onend = end
    u.onerror = end
    speechSynthesis.speak(u)
    // iOS sometimes never fires onend.
    setTimeout(() => { if (!speechSynthesis.speaking) end() }, Math.max(4000, text.length * 90))
  })
}
export const stopSpeaking = () => { speechSynthesis.cancel(); player.pause(); stopLevel() }

/** Listens continuously until a phrase matches (the wake line). Returns a stop function. */
export function listenFor(match: RegExp, onHit: (text: string) => void): () => void {
  if (!Recognition) return () => {}
  let active = true
  let rec: SR | null = null
  const start = () => {
    if (!active) return
    rec = new Recognition()
    rec.lang = 'es-CL'
    rec.interimResults = true
    rec.continuous = true
    rec.onresult = (e: any) => {
      let heard = ''
      for (let i = e.resultIndex; i < e.results.length; i++) heard += e.results[i][0].transcript
      if (active && match.test(heard)) { active = false; rec?.stop(); onHit(heard) }
    }
    rec.onerror = () => {}
    rec.onend = () => { if (active) setTimeout(start, 250) } // Chrome ends sessions on silence: keep it going
    try { rec.start() } catch { /* already running */ }
  }
  start()
  return () => { active = false; rec?.abort() }
}
