import { io } from 'socket.io-client'

function stripTrailingSlash(value = '') {
  return value.replace(/\/+$/, '')
}

function normalizePath(value = '') {
  if (!value) return '/socket.io'
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
  return withLeadingSlash.replace(/\/+$/, '')
}

export function detectIngressBase() {
  const candidates = [
    window.location.pathname,
    new URL(document.baseURI).pathname,
    import.meta.env.BASE_URL,
  ].filter(Boolean)

  for (const candidate of candidates) {
    const match = candidate.match(/^(\/api\/hassio_ingress\/[^/]+)/)
    if (match) {
      return match[1]
    }
  }

  return ''
}

function detectSocketPath() {
  if (import.meta.env.VITE_SOCKET_PATH) {
    return normalizePath(import.meta.env.VITE_SOCKET_PATH)
  }

  const ingressBase = detectIngressBase()
  if (ingressBase) {
    return `${stripTrailingSlash(ingressBase)}/socket.io`
  }

  const baseUrl = import.meta.env.BASE_URL || '/'
  const normalizedBase =
    baseUrl && baseUrl !== '/'
      ? normalizePath(baseUrl)
      : ''

  return normalizedBase
    ? `${stripTrailingSlash(normalizedBase)}/socket.io`
    : '/socket.io'
}

export function createSocket() {
  const url = import.meta.env.VITE_SOCKET_URL || window.location.origin
  const path = detectSocketPath()

  return io(url, {
    path,
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 5000,
    autoConnect: true,
  })
}