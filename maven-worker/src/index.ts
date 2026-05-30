import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { AppEnv } from './env'
import { jsonData, jsonError, notFound, toAppError } from './shared'
import { ensureAdminToken } from './tokens'
import { authApiRoutes } from './auth'
import { adminRoutes } from './admin'
import { mavenApiRoutes, handleFileGet, handleFileHead, handleFilePut, handleFileDelete } from './maven'

const app = new Hono<AppEnv>()
let adminBootstrapChecked = false

function serveStaticAsset(c: Context<AppEnv>): Response | Promise<Response> {
  if (!c.env.ASSETS) return c.notFound()
  return c.env.ASSETS.fetch(c.req.raw)
}

function isStaticAssetPath(path: string): boolean {
  return path === '/' || path === '/index.html' || path.startsWith('/assets/')
}

app.use('*', async (c: Context<AppEnv>, next: Next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)

  const origin = c.req.header('Origin')
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Generate-Checksums')
    c.header('Access-Control-Allow-Credentials', 'true')
    c.header('Access-Control-Max-Age', '86400')
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204)
  }

  if (!adminBootstrapChecked) {
    if (c.env.MAVEN_KV) {
      await ensureAdminToken(c.env.MAVEN_KV, c.env.ADMIN_BOOTSTRAP_TOKEN)
    }
    adminBootstrapChecked = true
  }

  await next()

  c.header('X-Request-Id', requestId)

  if (isStaticAssetPath(c.req.path)) return

  c.executionCtx.waitUntil(
    (async () => {
      if (!c.env.MAVEN_KV) return undefined
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const key = `stats:daily:${today}:requests`
      const current = await c.env.MAVEN_KV.get(key)
      await c.env.MAVEN_KV.put(key, String((Number(current) || 0) + 1))
      return undefined
    })()
  )
})

app.get('/api/status/health', (c) => {
  return jsonData(c, { status: 'ok' })
})

app.route('/api/auth', authApiRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/maven', mavenApiRoutes)

app.get('/', serveStaticAsset)
app.get('/index.html', serveStaticAsset)
app.get('/assets/*', serveStaticAsset)

app.get('/*', handleFileGet)
app.on('HEAD', '/*', handleFileHead)
app.put('/*', handleFilePut)
app.post('/*', handleFilePut)
app.delete('/*', handleFileDelete)

app.onError((error, c) => {
  const kv = c.env.MAVEN_KV
  if (kv) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    c.executionCtx.waitUntil(
      (async () => {
        const key = `stats:daily:${today}:errors`
        const current = await kv.get(key)
        await kv.put(key, String((Number(current) || 0) + 1))
        return undefined
      })()
    )
  }

  return jsonError(c, toAppError(error))
})

app.notFound((c) => {
  return jsonError(c, notFound('Route not found'))
})

export default app
