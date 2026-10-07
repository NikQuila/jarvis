// ?hora=09:45 makes the HUD live "as if it were 09:45 today" (to record a morning at night). The clock keeps ticking
// from there; the agenda and the spoken briefing use the same time.
const m = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get('hora') ?? '')
export const FAKE_HOUR = m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
const offset = (() => {
  if (!m) return 0
  const target = new Date()
  target.setHours(Number(m[1]), Number(m[2]), 0, 0)
  return target.getTime() - Date.now()
})()
export const nowMs = () => Date.now() + offset
