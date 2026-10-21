import { defineConfig } from 'vite'

// One public web port: the browser talks only to this server, which forwards the lobby
// API and Geckos signaling to the game server on the same machine. Only the WebRTC UDP
// port (see README) has to be reachable besides this one.
const lobbyApiPort = process.env.LOBBY_API_PORT ?? '9208'
const geckosPort = process.env.GECKOS_PORT ?? '9209'
const webPort = Number(process.env.CLIENT_PORT ?? 5173)

const serverOptions = {
  host: true,
  port: webPort,
  strictPort: true,
  allowedHosts: true,
  proxy: {
    '/api': `http://127.0.0.1:${lobbyApiPort}`,
    '/.wrtc': `http://127.0.0.1:${geckosPort}`,
  },
}

export default defineConfig({
  server: serverOptions,
  preview: serverOptions,
})
