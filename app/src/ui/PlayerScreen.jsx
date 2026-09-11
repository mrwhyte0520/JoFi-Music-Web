import { useRef, useState } from 'react'
import { usePlayer } from '../state/PlayerContext'
import { artworkFallback, formatDuration, thumbFor } from '../lib/format'
import useDominantColor from '../hooks/useDominantColor'
import {
  IconChevronDown, IconDots, IconHeart, IconHeartFill,
  IconMusic, IconNext, IconPause, IconPlay, IconPrev, IconQueue, IconRepeat,
  IconShare, IconShuffle
} from './icons'

export default function PlayerScreen() {
  const { state, tick, actions, currentSong, isLiked, toggleLike } = usePlayer()
  const song = currentSong()
  const c = actions.controls

  const [drag, setDrag] = useState(false)
  const trackRef = useRef(null)
  const panRef = useRef(null)
  const panY = useRef(0)
  const startY = useRef(0)

  const dur = tick.duration > 0 ? tick.duration : (song && song.duration) || 0
  const pct = dur > 0 ? Math.min(100, (tick.current / dur) * 100) : 0
  const color = useDominantColor(song && song.thumb ? thumbFor(song.thumb, 512) : null)
  const liked = song ? isLiked(song) : false

  const bg = color
    ? `linear-gradient(180deg, rgba(${color},0.92) 0%, rgba(${color},0.5) 34%, #191e1c 62%, #090909 100%)`
    : `linear-gradient(180deg, #2c3a37 0%, #242b29 40%, #161a19 70%, #090909 100%)`

  const back = () => actions.back()

  /* rebusca en la barra de progreso */
  const seekFromEvent = (e) => {
    if (!dur || !trackRef.current) return
    const r = trackRef.current.getBoundingClientRect()
    const x = e.clientX != null ? e.clientX : e.touches[0].clientX
    const t = ((x - r.left) / r.width) * dur
    c.seekTo(Math.max(0, Math.min(dur, t)))
  }

  const onPointerDown = (e) => {
    setDrag(true)
    const grab = (ev) => seekFromEvent(ev)
    const release = () => {
      document.removeEventListener('pointermove', grab)
      document.removeEventListener('pointerup', release)
      setDrag(false)
    }
    document.addEventListener('pointermove', grab)
    document.addEventListener('pointerup', release)
    seekFromEvent(e)
  }

  /* gesto: arrastrar hacia abajo cierra el reproductor */
  const onPanDown = (e) => {
    startY.current = e.clientY
    panY.current = 0
  }
  const onPanMove = (e) => {
    if (e.clientY > startY.current) {
      panY.current = e.clientY - startY.current
      if (panRef.current) {
        panRef.current.style.transform = `translateY(${Math.min(200, panY.current)}px)`
        panRef.current.style.opacity = String(Math.max(0.35, 1 - panY.current / 220))
      }
    }
  }
  const onPanUp = () => {
    const y = panY.current
    if (panRef.current) {
      panRef.current.style.transform = ''
      panRef.current.style.opacity = ''
    }
    panY.current = 0
    if (y > 90) back()
  }

  const share = () => {
    if (!song) return
    const text = `Escuchando "${song.title}" de ${song.artist} en JoFi Music`
    if (navigator.share) {
      navigator.share({ title: song.title, text }).catch(() => {})
    } else {
      navigator.clipboard?.writeText(text).then(() => actions.toast('Copiado al portapapeles')).catch(() => {})
    }
  }

  const showQueue = () => {
    actions.showDialog(
      'En la cola',
      state.queue.length
        ? state.queue.map((s, i) => `${i + 1}. ${s.title} — ${s.artist}`).join('\n')
        : 'Cola vacía',
      [{ label: 'Cerrar' }]
    )
  }

  if (!song) return null

  return (
    <div className="nowplaying" style={{ background: bg }}>
      <div
        ref={panRef}
        className="np-panel"
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanUp}
      >
        <header className="np-head">
          <button className="icon-btn" onClick={back} aria-label="Cerrar reproductor">
            <IconChevronDown width={22} height={22} />
          </button>
          <div className="np-headinfo">
            <span className="np-source">REPRODUCIENDO DESDE PLAYLIST</span>
            <span className="np-list">{state.listTitle}</span>
          </div>
          <button className="icon-btn" onClick={() => actions.openLyrics(song)} aria-label="Ver letras">
            <IconDots width={18} height={18} />
          </button>
        </header>

        <div className="np-cover">
          {song.thumb ? (
            <img src={thumbFor(song.thumb, 512)} alt="" draggable={false} decoding="async" onError={artworkFallback} />
          ) : (
            <span className="np-empty"><IconMusic width={64} height={64} /></span>
          )}
        </div>

        <div className="np-right">
          <div className="np-track">
            <div className="np-titles">
              <h2 title={song.title}>{song.title}</h2>
              <p title={song.artist}>{song.artist}</p>
            </div>
            <button
              key={liked ? 'l1' : 'l0'}
              className={`np-like ${liked ? 'liked' : ''}`}
              aria-label={liked ? 'Quitar de favoritos' : 'Guardar en favoritos'}
              onClick={(e) => {
                e.stopPropagation()
                const added = toggleLike(song)
                actions.toast(added ? 'Guardada en favoritas' : 'Eliminada de favoritas')
              }}
            >
              {liked ? <IconHeartFill width={22} height={22} /> : <IconHeart width={22} height={22} />}
            </button>
          </div>

          <div className={`np-progress ${drag ? 'dragging' : ''}`} onPointerDown={onPointerDown} ref={trackRef}>
            <div className="np-bar"><div className="np-fill" style={{ width: `${pct}%`, transition: drag ? 'none' : undefined }} /></div>
            <div className="np-thumb" style={{ left: `calc(${pct}% - 5px)`, transition: drag ? 'none' : undefined }} />
          </div>
          <div className="np-times">
            <span>{formatDuration(tick.current)}</span>
            <span>−{formatDuration(Math.max(0, dur - tick.current))}</span>
          </div>

          <div className="np-controls">
            <button
              className={`np-tbtn ${state.shuffle ? 'on' : ''}`}
              onClick={c.toggleShuffle}
              aria-label="Aleatorio"
              title="Aleatorio"
            >
              <IconShuffle width={21} height={21} />
            </button>
            <button className="np-nav" onClick={c.prev} aria-label="Anterior" title="Anterior">
              <IconPrev width={30} height={30} />
            </button>
            <button className="np-play" onClick={c.togglePlay} aria-label={state.playing ? 'Pausar' : 'Reproducir'}>
              {state.playing ? <IconPause width={27} height={27} /> : <IconPlay width={27} height={27} />}
            </button>
            <button className="np-nav" onClick={c.next} aria-label="Siguiente" title="Siguiente">
              <IconNext width={30} height={30} />
            </button>
            <button
              className={`np-tbtn ${state.repeat !== 'off' ? 'on' : ''}`}
              onClick={c.toggleRepeat}
              aria-label="Repetir"
              title={`Repetir: ${state.repeat === 'one' ? 'una canción' : state.repeat === 'all' ? 'toda la lista' : 'desactivado'}`}
            >
              <IconRepeat width={21} height={21} />
              {state.repeat === 'one' && <span className="np-num">1</span>}
            </button>
          </div>
        </div>

        <div className="np-bottom">
          <div className="np-bottomchips">
            <button className="np-bbn" onClick={showQueue} aria-label="Ver cola" title="Cola">
              <IconQueue width={22} height={22} />
            </button>
            <button className="np-bbn" onClick={share} aria-label="Compartir" title="Compartir">
              <IconShare width={22} height={22} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
