import { io } from 'socket.io-client'

async function resolveSocketPath() {
  if (import.meta.env.VITE_SOCKET_PATH) {
    const p = import.meta.env.VITE_SOCKET_PATH
    return p.startsWith('/') ? p : `/${p}`
  }

  try {
    const res = await fetch('./api/runtime-config')
    if (res.ok) {
      const { ingressPath } = await res.json()
      if (ingressPath) return `${ingressPath}/socket.io`
    }
  } catch (_) {}

  return '/socket.io'
}

export async function createSocket() {
  const url = import.meta.env.VITE_SOCKET_URL || window.location.origin
  const path = await resolveSocketPath()

  return io(url, {
    path,
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 5000,
    autoConnect: true,
  })
}
