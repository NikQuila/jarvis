# Audio credits

All three tracks are by **Kevin MacLeod** (incompetech.com), licensed
**Creative Commons Attribution 4.0**. Free to use commercially — including in a
monetised YouTube video — provided the attribution below appears somewhere the
audience can see it (a description box is fine).

| File | Track | Used for |
|---|---|---|
| `boot-music.mp3` | *Impact Prelude* | The swell when the reactor comes up |
| `ambient.mp3` | *Ossuary 6 – Air* | Low bed looping under the interface |
| `work.mp3` | *Mechanolith* | Rises while a tool is running |

## Attribution to paste into a video description

```
Music by Kevin MacLeod (incompetech.com)
  "Impact Prelude"    — Licensed under Creative Commons: By Attribution 4.0
  "Ossuary 6 - Air"   — Licensed under Creative Commons: By Attribution 4.0
  "Mechanolith"       — Licensed under Creative Commons: By Attribution 4.0
http://creativecommons.org/licenses/by/4.0/
```

## Why not the actual Iron Man score

Disney/Marvel run one of the most aggressive Content ID operations on YouTube.
Real film score or JARVIS dialogue in an upload means a near-certain claim,
demonetisation, or a strike — on a video whose whole point is to be seen. These
tracks are in the same register and cost you a line of text instead.

## Replacing them

Drop in any MP3 with the same filename and it takes over — nothing in the code
references the track names. Other sources worth a look: incompetech.com (same
licence), Pixabay Music (CC0, no attribution at all), and the YouTube Audio
Library.

The code that plays them is `src/nik/music.ts`: the boot swell when you tap to
start, the ambient bed after that, and the work track while JARVIS is thinking.
Press M in the HUD to mute (remembered in the browser).
