import React, {
  createContext, useCallback, useContext, useEffect, useReducer, useRef, useState
} from 'react'
import * as api from '../services/api'
import { logger } from '../services/logger'
import {
  initMediaSession, updateMediaSession, clearMediaSession, updatePosition
} from '../services/mediaSession'
import { countryInfo, RANDOM_POOL } from '../lib/constants'
import { thumbFor } from '../lib/format'

const Ctx = createContext(null)
export const usePlayer = () => useContext(Ctx)

const FAV_KEY = 'playtube.favs.v1'
const SESSION_KEY = 'playtube.session.v1'
const pick = (pool) => pool[Math.floor(Math.random() * pool.length)]

function loadFavs() {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* sin favoritos previos */ }
  return []
}

/* Estado de reproducción guardado → permite seguir escuchando
   después de recargar la página (a partir de donde quedó). */
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!s || !Array.isArray(s.queue) || s.current < 0 || s.current >= s.queue.length) return null
    if (!s.queue[s.current]) return null
    return s
  } catch { /* sin sesión previa */ }
  return null
}

const initialSession = loadSession()
let RESUME_DONE = false

const initialState = {
  screen: 'list',          // 'list' = shell con tabs · 'player' = overlay Now Playing
  tab: initialSession?.tab || 'inicio',   // 'inicio' | 'buscar' | 'biblioteca' | 'lista'
  cc: initialSession?.cc || 'do',
  listTitle: initialSession?.listTitle || 'Top República Dominicana',
  queue: initialSession?.queue || [],
  current: initialSession ? initialSession.current : -1,
  playing: false,
  shuffle: initialSession?.shuffle ?? false,
  repeat: initialSession?.repeat || 'off',   // 'off' | 'all' | 'one'
  volume: initialSession?.volume ?? 80,
  muted: initialSession?.muted ?? false,
  busy: null,
  lyrics: null,
  favs: loadFavs()
}

function reducer(s, a) {
  switch (a.type) {
    case 'SCREEN': return { ...s, screen: a.s }
    case 'TAB': return { ...s, tab: a.t }
    case 'CC': return { ...s, cc: a.c }
    case 'LOAD_SONGS': return { ...s, queue: a.songs, current: -1, playing: false, listTitle: a.title }
    case 'SET_CURRENT': return { ...s, current: a.i }
    case 'SET_PLAYING': return { ...s, playing: a.v }
    case 'SHUFFLE': return { ...s, shuffle: !s.shuffle }
    case 'REPEAT': {
      const next = s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off'
      return { ...s, repeat: next }
    }
    case 'VOLUME': return { ...s, volume: a.v, muted: false }
    case 'MUTE': return { ...s, muted: !s.muted }
    case 'BUSY': return { ...s, busy: a.text }
    case 'LYRICS': return a.p
      ? { ...s, lyrics: { songId: a.songId, song: a.song, busy: !!a.busy, timed: !!a.timed, plain: a.plain || null, lines: a.lines || [], follow: !!a.follow } }
      : { ...s, lyrics: null }
    case 'SET_FAVS': return { ...s, favs: a.favs }
    default: return s
  }
}

export function PlayerProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [tick, setTick] = useState({ current: 0, duration: 0 })
  const [toasts, setToasts] = useState([])
  const [dialog, setDialog] = useState(null)

  const audioRef = useRef(null)
  const streamCache = useRef(new Map())
  const proxyUsed = useRef(new Set())
  const refreshUsed = useRef(new Set())
  const prefetching = useRef(new Map())
  const positionMap = useRef(new Map())
  const stateRef = useRef(state)
  stateRef.current = state

  /* ---------- persistencia de la sesión (recargar no corta la música) ---------- */
  const persistTimer = useRef(0)
  const persistNow = useCallback(() => {
    const a = audioRef.current
    const st = stateRef.current
    const song = st.current >= 0 ? st.queue[st.current] : null
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        stamp: Date.now(),
        tab: st.tab,
        cc: st.cc,
        listTitle: st.listTitle,
        queue: st.queue,
        current: st.current,
        playing: st.playing,
        currentTime: a ? (a.currentTime || 0) : 0,
        duration: a && a.duration ? a.duration : (song ? song.duration || 0 : 0),
        streamUrl: song && song.ytmId ? (streamCache.current.get(song.ytmId) || null) : null,
        shuffle: st.shuffle,
        repeat: st.repeat,
        volume: st.volume,
        muted: st.muted
      }))
    } catch { /* almacenamiento lleno / bloqueado */ }
  }, [])

  const persistThrottled = useCallback(() => {
    clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(persistNow, 2500)
  }, [persistNow])

  /* guarda también al ocultar/cerrar la pestaña (momento exacto) */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') persistNow()
    }
    window.addEventListener('pagehide', persistNow)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', persistNow)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [persistNow])

  useEffect(() => {
    persistThrottled()
  }, [state.tab, state.cc, state.listTitle, state.playing, state.queue, persistThrottled])

  useEffect(() => {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(state.favs))
    } catch { /* silencioso */ }
  }, [state.favs])

  /* ---------- botón "atrás" del sistema (Android) ---------- */
  /* Sin esto, el overlay del reproductor/letras no cuenta como una
     "pantalla" para el navegador: el botón atrás sale de la app entera
     y corta la música. Empujamos una entrada de historial al abrir cada
     overlay y la consumimos al cerrar (por botón o por atrás real),
     para que atrás solo cierre el overlay en vez de salir de la app. */
  useEffect(() => {
    if (state.screen === 'player') window.history.pushState({ jofiOverlay: 'player' }, '')
  }, [state.screen === 'player'])

  useEffect(() => {
    if (state.lyrics) window.history.pushState({ jofiOverlay: 'lyrics' }, '')
  }, [!!state.lyrics])

  useEffect(() => {
    const onPopState = () => {
      if (stateRef.current.lyrics) {
        dispatch({ type: 'LYRICS', p: false })
        return
      }
      if (stateRef.current.screen === 'player') {
        dispatch({ type: 'SCREEN', s: 'list' })
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const showDialog = useCallback((title, message, actions = [{ label: 'Cerrar' }], opts = {}) => {
    setDialog({ title, message, actions, ...opts })
  }, [])
  const closeDialog = useCallback(() => setDialog(null), [])
  const toast = useCallback((msg, { error = false, duration = 3200 } = {}) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, msg, error }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duration)
  }, [])

  const currentSong = useCallback(() => {
    const { queue, current } = stateRef.current
    return current >= 0 ? queue[current] : null
  }, [])

  const isLiked = useCallback((song) => {
    if (!song || !song.ytmId) return false
    return stateRef.current.favs.some((f) => f.ytmId === song.ytmId)
  }, [])

  const toggleLike = useCallback((song) => {
    if (!song || !song.ytmId) return false
    const { favs } = stateRef.current
    const exists = favs.some((f) => f.ytmId === song.ytmId)
    const next = exists ? favs.filter((f) => f.ytmId !== song.ytmId) : [...favs, song]
    dispatch({ type: 'SET_FAVS', favs: next })
    return !exists
  }, [])

  /* ---------- audio ---------- */
  useEffect(() => {
    const a = new Audio()
    a.preload = 'metadata'
    a.setAttribute('playsinline', '')
    a.volume = stateRef.current.volume / 100
    audioRef.current = a

    const onTime = () => {
      setTick({ current: a.currentTime || 0, duration: a.duration || 0 })
      updatePosition({ current: a.currentTime || 0, duration: a.duration || 0 })
      const s = currentSong()
      if (s && s.ytmId) positionMap.current.set(s.ytmId, a.currentTime || 0)
      persistThrottled()
    }
    const onPlay = () => {
      dispatch({ type: 'SET_PLAYING', v: true })
      const s = currentSong()
      if (s) {
        updateMediaSession(
          { ...s, thumb: thumbFor(s.thumb, 512) },
          a.duration || s.duration || 0,
          true,
          a.currentTime || 0
        )
      }
      persistThrottled()
    }
    const onPause = () => {
      dispatch({ type: 'SET_PLAYING', v: false })
      const s = currentSong()
      if (s && s.ytmId) positionMap.current.set(s.ytmId, a.currentTime || 0)
      if (s) {
        updateMediaSession(
          { ...s, thumb: thumbFor(s.thumb, 512) },
          a.duration || s.duration || 0,
          false,
          a.currentTime || 0
        )
      }
      persistNow()
    }

    a.addEventListener('timeupdate', onTime)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    return () => {
      a.pause()
      a.src = ''
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      clearMediaSession()
    }
  }, [currentSong, persistNow, persistThrottled])

  const resumeTapRef = useRef(false)

  /* ---------- reanudar tras recargar la página ---------- */
  useEffect(() => {
    if (RESUME_DONE || !initialSession || !initialSession.playing || initialSession.current < 0) return
    const st = stateRef.current
    const song = st.queue[st.current]
    if (!song || !song.ytmId) return
    RESUME_DONE = true
    let alive = true
    dispatch({ type: 'BUSY', text: 'Reanudando…' })
    ;(async () => {
      try {
        let url = initialSession.streamUrl || streamCache.current.get(song.ytmId) || null
        if (!url) {
          const d = await api.resolveSong(song.ytmId)
          url = d.url
        }
        if (!alive) return
        streamCache.current.set(song.ytmId, url)
        const a = audioRef.current
        if (!a) return
        const setPos = () => {
          try {
            const dur = a.duration && Number.isFinite(a.duration) ? a.duration : initialSession.duration || 0
            const maxPos = Math.max(0, dur - 1)
            a.currentTime = Math.min(initialSession.currentTime || 0, maxPos)
          } catch { /* seeking aún no disponible */ }
          a.removeEventListener('loadedmetadata', setPos)
        }
        a.addEventListener('loadedmetadata', setPos)
        a.src = url
        try {
          await a.play()
          dispatch({ type: 'SET_PLAYING', v: true })
        } catch {
          dispatch({ type: 'SET_PLAYING', v: false })
          toast('Toca reproducir para continuar la canción')
          resumeTapRef.current = true
        }
        persistNow()
      } catch (e) {
        logger.error('no se pudo reanudar la reproducción', e)
      } finally {
        if (alive) dispatch({ type: 'BUSY', text: null })
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, persistNow])

  /* si el autoplay bloqueó la reanudación, continuarla al primer toque */
  useEffect(() => {
    const tryResume = () => {
      if (!resumeTapRef.current) return
      resumeTapRef.current = false
      const a = audioRef.current
      if (!a || !a.paused) return
      a.play().catch(() => {})
    }
    window.addEventListener('pointerdown', tryResume)
    window.addEventListener('touchend', tryResume)
    return () => {
      window.removeEventListener('pointerdown', tryResume)
      window.removeEventListener('touchend', tryResume)
    }
  }, [])

  const playIndex = useCallback(async (index, opts = {}, qOverride = null) => {
    const q = qOverride || stateRef.current.queue
    if (!q[index]) return
    const song = q[index]
    const cur = currentSong()

    /* Misma canción → NO reiniciar: continuar donde iba */
    if (song && song.ytmId && cur && cur.ytmId === song.ytmId) {
      dispatch({ type: 'SET_CURRENT', i: index })
      if (opts.screen !== false) dispatch({ type: 'SCREEN', s: 'player' })
      const a = audioRef.current
      if (!a) return
      if (a.src) {
        if (a.paused) a.play().catch(() => dispatch({ type: 'SET_PLAYING', v: false }))
        return
      }
      dispatch({ type: 'BUSY', text: 'Reanudando…' })
      try {
        const d = await api.resolveSong(song.ytmId)
        streamCache.current.set(song.ytmId, d.url)
        const setPos = () => {
          try {
            const saved = positionMap.current.get(song.ytmId) || initialSession.currentTime || 0
            const maxPos = Math.max(0, (a.duration || 0) - 1)
            a.currentTime = Math.min(saved, maxPos)
          } catch { /* seeking aún no disponible */ }
          a.removeEventListener('loadedmetadata', setPos)
        }
        a.addEventListener('loadedmetadata', setPos)
        a.src = d.url
        a.play().catch(() => dispatch({ type: 'SET_PLAYING', v: false }))
      } catch (e) {
        logger.error('no se pudo reanudar la canción', e)
      } finally {
        dispatch({ type: 'BUSY', text: null })
      }
      return
    }

    dispatch({ type: 'SET_CURRENT', i: index })
    if (opts.screen !== false) dispatch({ type: 'SCREEN', s: 'player' })

    let url = song.ytmId ? streamCache.current.get(song.ytmId) : ''
    if (!url) {
      if (!song.ytmId) {
        showDialog('Sin audio', 'Esta canción no tiene audio disponible.', [{ label: 'Entendido' }])
        dispatch({ type: 'SET_PLAYING', v: false })
        return
      }
      dispatch({ type: 'BUSY', text: 'Cargando la canción completa…' })
      try {
        const d = await api.resolveSong(song.ytmId)
        url = d.url
        streamCache.current.set(song.ytmId, d.url)
      } catch (e) {
        logger.error('no se pudo resolver el stream', e)
        dispatch({ type: 'BUSY', text: null })
        dispatch({ type: 'SET_PLAYING', v: false })
        showDialog('No se pudo obtener el audio', String((e && e.message) || e), [{ label: 'Entendido' }])
        return
      }
      dispatch({ type: 'BUSY', text: null })
    }

    proxyUsed.current.delete(song.ytmId)
    const a = audioRef.current
    if (!a) return
    a.src = url
    a.play().catch(() => {
      logger.info('autoplay bloqueado, esperando clic')
      dispatch({ type: 'SET_PLAYING', v: false })
      toast('Toca el botón para reproducir', { error: true })
    })
  }, [showDialog, toast])

  const nextSong = useCallback(() => {
    const { queue, current, shuffle } = stateRef.current
    if (!queue.length) return
    const i = shuffle
      ? Math.floor(Math.random() * queue.length)
      : (current + 1) % queue.length
    playIndex(i)
  }, [playIndex])

  const prevSong = useCallback(() => {
    const a = audioRef.current
    if (a && a.currentTime > 3) {
      a.currentTime = 0
      setTick({ current: 0, duration: a.duration || 0 })
      return
    }
    const { queue, current } = stateRef.current
    if (!queue.length) return
    playIndex(((current - 1 + queue.length) % queue.length))
  }, [playIndex])

  const togglePlay = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    if (stateRef.current.current === -1) {
      if (stateRef.current.queue.length) playIndex(0)
      return
    }
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }, [playIndex])

  const seekTo = useCallback((t) => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, t)
    setTick({ current: a.currentTime, duration: a.duration || 0 })
    updatePosition({ current: a.currentTime, duration: a.duration || 0 })
    persistNow()
  }, [persistNow])
  const seekBy = useCallback((delta, seekOffset) => {
    const a = audioRef.current
    if (!a) return
    if (typeof seekOffset === 'number') {
      seekTo(seekOffset)
      return
    }
    if (!a.duration) return
    seekTo(a.currentTime + delta)
  }, [seekTo])

  /* fin de canción según repeat */
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onEnded = () => {
      const { queue, current, shuffle, repeat } = stateRef.current
      if (repeat === 'one' && queue.length) {
        a.currentTime = 0
        a.play().catch(() => {})
        return
      }
      if (!queue.length) return
      if (queue.length === 1) {
        if (repeat === 'all') {
          a.currentTime = 0
          a.play().catch(() => {})
        }
        return
      }
      let i
      if (shuffle) {
        i = Math.floor(Math.random() * queue.length)
      } else if (current + 1 < queue.length) {
        i = current + 1
      } else if (repeat === 'all') {
        i = 0
      } else {
        a.currentTime = 0
        return
      }
      playIndex(i)
    }
    const onError = () => {
      const s = currentSong()
      if (s && s.ytmId) {
        const u = streamCache.current.get(s.ytmId)
        if (u && u.startsWith('https://') && !proxyUsed.current.has(s.ytmId)) {
          proxyUsed.current.add(s.ytmId)
          logger.info('stream directo falló → proxy local')
          a.src = `/api/audio?u=${encodeURIComponent(u)}`
          a.play().catch(() => {})
          return
        }
        if (!refreshUsed.current.has(s.ytmId)) {
          refreshUsed.current.add(s.ytmId)
          logger.info('stream falló → re-resolviendo')
          dispatch({ type: 'BUSY', text: 'Reintentando la canción…' })
          api.resolveSong(s.ytmId, { refresh: true })
            .then((d) => {
              if (!d || !d.url) throw new Error('sin url')
              streamCache.current.set(s.ytmId, d.url)
              proxyUsed.current.delete(s.ytmId)
              a.src = d.url
              a.play().catch(() => dispatch({ type: 'SET_PLAYING', v: false }))
            })
            .catch(() => {
              logger.error(`error reproduciendo "${s.title}"`)
              toast(`No se pudo reproducir: ${s.title}`, { error: true })
            })
            .finally(() => dispatch({ type: 'BUSY', text: null }))
          return
        }
      }
      logger.error(`error reproduciendo "${s ? s.title : ''}"`)
      toast(`No se pudo reproducir: ${s ? s.title : 'la canción'}`, { error: true })
    }
    a.addEventListener('ended', onEnded)
    a.addEventListener('error', onError)
    return () => {
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('error', onError)
    }
  }, [currentSong, playIndex, toast])

  /* carga y reproduce una cola en un solo paso (carruseles) */
  const playSongs = useCallback((songs, index, title = '') => {
    const list = songs && songs.length ? songs : stateRef.current.queue
    if (!list[index]) return
    dispatch({ type: 'LOAD_SONGS', songs: list, title })
    dispatch({ type: 'SET_PLAYING', v: false })
    playIndex(index, { screen: true }, list)
  }, [playIndex])

  /* ---------- precarga de streams (que el paso a la siguiente canción sea instantáneo) ---------- */
  const prefetchStream = useCallback(async (song) => {
    if (!song || !song.ytmId) return
    if (streamCache.current.has(song.ytmId)) return
    if (prefetching.current.has(song.ytmId)) return
    prefetching.current.set(song.ytmId, true)
    try {
      const d = await api.resolveSong(song.ytmId)
      if (d && d.url) streamCache.current.set(song.ytmId, d.url)
    } catch (e) {
      logger.info(`prefetch fallido: ${song.ytmId}`)
    } finally {
      prefetching.current.delete(song.ytmId)
    }
  }, [])

  /* al cargar una lista → deja lista la primera y segunda canción */
  useEffect(() => {
    const { queue } = stateRef.current
    if (!queue || !queue.length) return
    prefetchStream(queue[0])
    if (queue[1]) prefetchStream(queue[1])
  }, [state.queue, prefetchStream])

  /* al cambiar de canción → siguiente y anterior ya resueltas */
  useEffect(() => {
    const { queue, current, shuffle } = stateRef.current
    if (current < 0 || !queue.length || !queue[current]) return
    const cur = queue[current]
    const next = shuffle
      ? queue[Math.floor(Math.random() * queue.length)]
      : queue[(current + 1) % queue.length]
    const prev = queue[(current - 1 + queue.length) % queue.length]
    if (next && next.ytmId !== cur.ytmId) prefetchStream(next)
    if (prev && prev.ytmId !== cur.ytmId) prefetchStream(prev)
  }, [state.current, state.shuffle, prefetchStream])

  /* ---------- MediaSession ---------- */
  useEffect(() => {
    const off = initMediaSession({
      onPlay: () => {
        const a = audioRef.current
        if (a && a.paused && stateRef.current.current >= 0) a.play().catch(() => {})
      },
      onPause: () => {
        const a = audioRef.current
        if (a && !a.paused) a.pause()
      },
      onNext: nextSong,
      onPrev: prevSong,
      seekBy,
      seekTo
    })
    return off
  }, [nextSong, prevSong, seekBy, seekTo])

  /* ---------- carga de listas ---------- */
  const loadCharts = useCallback(async (cc) => {
    dispatch({ type: 'BUSY', text: 'Cargando el top del momento…' })
    try {
      const d = await api.getCharts(cc)
      const songs = (d.songs || []).map(api.toSong)
      dispatch({ type: 'LOAD_SONGS', songs, title: `Top ${countryInfo(cc).name}` })
      if (!songs.length) toast('El top salió vacío', { error: true })
    } catch (e) {
      logger.error('no se pudo cargar el top', e)
      const local = ['localhost', '127.0.0.1'].includes(window.location.hostname)
      const hint = local ? '¿Corriste iniciar.bat?' : 'Inténtalo nuevamente en unos segundos.'
      showDialog('Error de conexión', `No se pudo conectar con el servicio de música. ${hint}`, [{ label: 'Entendido' }])
    } finally {
      dispatch({ type: 'BUSY', text: null })
    }
  }, [showDialog, toast])

  const searchList = useCallback(async (q, opts = {}) => {
    dispatch({ type: 'BUSY', text: 'Buscando…' })
    try {
      const d = await api.searchSongs(q)
      const songs = (d.songs || []).map(api.toSong)
      dispatch({ type: 'LOAD_SONGS', songs, title: `“${q}”` })
      if (opts.tab) dispatch({ type: 'TAB', t: opts.tab })
      if (!songs.length) toast('Sin resultados para esa búsqueda', { error: true })
    } catch (e) {
      logger.error('no se pudo buscar', e)
      showDialog('Error de búsqueda', 'No se pudo contactar al servidor.', [{ label: 'Entendido' }])
    } finally {
      dispatch({ type: 'BUSY', text: null })
    }
  }, [showDialog, toast])

  const randomList = useCallback(async () => {
    const g = pick(RANDOM_POOL)
    dispatch({ type: 'BUSY', text: 'Escogiendo algo aleatorio…' })
    try {
      const d = await api.searchSongs(g)
      const songs = (d.songs || []).map(api.toSong)
      dispatch({ type: 'LOAD_SONGS', songs, title: `Aleatorio · ${g[0].toUpperCase()}${g.slice(1)}` })
      if (!songs.length) toast('Sin resultados', { error: true })
    } catch (e) {
      logger.error('fallo el aleatorio', e)
      showDialog('Error', 'No se pudo cargar la lista aleatoria.', [{ label: 'Entendido' }])
    } finally {
      dispatch({ type: 'BUSY', text: null })
    }
  }, [showDialog, toast])

  const openFavorites = useCallback(async () => {
    const favs = stateRef.current.favs
    if (!favs.length) {
      toast('Aún no tienes canciones guardadas', { error: true })
      return
    }
    dispatch({ type: 'LOAD_SONGS', songs: favs, title: 'Tus favoritas' })
    dispatch({ type: 'TAB', t: 'buscar' })
  }, [toast])

  /* ---------- letras ---------- */
  const lyricsCache = useRef(new Map())

  const applyLyrics = useCallback((payload, song, id, follow) => {
    if (stateRef.current.lyrics?.songId !== id) return
    dispatch({
      type: 'LYRICS', p: true, songId: id, song, follow,
      lines: payload.lines, plain: payload.plain || '', timed: payload.timed
    })
  }, [])

  const openLyrics = useCallback(async (song, opts = {}) => {
    if (!song) return
    const id = song.ytmId || song.videoId || 'x'
    const follow = !!currentSong() && currentSong().ytmId === id
    const cachedLy = lyricsCache.current.get(id)
    if (cachedLy) {
      dispatch({
        type: 'LYRICS', p: true, songId: id, song, follow,
        lines: cachedLy.lines, plain: cachedLy.plain || '', timed: cachedLy.timed
      })
      return
    }
    dispatch({ type: 'LYRICS', p: true, songId: id, song, follow, busy: true })
    try {
      let payload = null
      const timed = await api.timedLyrics(song)
      if (timed && timed.lines && timed.lines.length) {
        payload = { lines: timed.lines, plain: timed.plain || '', timed: true }
      } else {
        const text = (await api.backendLyrics(id)) || (await api.ovhLyrics(song.artist, song.title))
        const lines = text
          ? text.split('\n').map((l) => ({ text: l.replace(/\s+/g, ' ').trim() })).filter((l) => l.text)
          : []
        payload = { lines, plain: text || '', timed: false }
      }
      lyricsCache.current.set(id, payload)
      applyLyrics(payload, song, id, follow)
    } catch (e) {
      logger.error('no se pudieron cargar las letras', e)
      lyricsCache.current.set(id, { lines: [], plain: '', timed: false })
      applyLyrics({ lines: [], plain: '', timed: false }, song, id, follow)
    }
  }, [applyLyrics, currentSong])

  const closeLyrics = useCallback(() => {
    if (stateRef.current.lyrics) window.history.back()
    else dispatch({ type: 'LYRICS', p: false })
  }, [])

  /* si las letras están abiertas siguiendo la canción actual y ésta cambia, seguirlas */
  useEffect(() => {
    const ly = state.lyrics
    if (!ly || !ly.follow) return
    const cur = currentSong()
    if (!cur || !cur.ytmId || cur.ytmId === ly.songId) return
    openLyrics(cur)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lyrics, state.current])

  const getPlaybackPosition = useCallback(() => {
    const a = audioRef.current
    return a ? a.currentTime * 1000 : 0
  }, [])
  const seekMs = useCallback((ms) => seekTo(ms / 1000), [seekTo])

  const controls = {
    togglePlay,
    next: nextSong,
    prev: prevSong,
    seekTo,
    seekBy,
    toggleShuffle: () => dispatch({ type: 'SHUFFLE' }),
    toggleRepeat: () => dispatch({ type: 'REPEAT' }),
    setVolume: (v) => {
      const a = audioRef.current
      if (a) a.volume = v / 100
      dispatch({ type: 'VOLUME', v })
    },
    toggleMute: () => {
      const a = audioRef.current
      const muted = !stateRef.current.muted
      if (a) a.muted = muted
      dispatch({ type: 'MUTE' })
    }
  }

  const value = {
    state,
    tick,
    toasts,
    dialog,
    favs: state.favs,
    restored: !!initialSession,
    lyrics: state.lyrics,
    getPlaybackPosition,
    seekMs,
    showDialog,
    closeDialog,
    toast,
    currentSong,
    isLiked,
    toggleLike,
    actions: {
      showDialog,
      toast,
      loadCharts,
      searchList,
      randomList,
      openFavorites,
      playIndex,
      playSongs,
      openLyrics,
      closeLyrics,
      back: () => {
        if (stateRef.current.screen === 'player') window.history.back()
        else dispatch({ type: 'SCREEN', s: 'list' })
      },
      openPlayer: () => dispatch({ type: 'SCREEN', s: 'player' }),
      setTab: (t) => dispatch({ type: 'TAB', t }),
      setCc: (c) => dispatch({ type: 'CC', c }),
      controls
    }
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
