import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { AppEnv } from './env'
import { jsonData, jsonError, notFound, toAppError } from './shared'
import { ensureAdminToken } from './tokens'
import { authApiRoutes } from './auth'
import { adminRoutes } from './admin'
import { mavenApiRoutes, handleFileGet, handleFileHead, handleFilePut, handleFileDelete } from './maven'

const app = new Hono<AppEnv>()

app.use('*', async (c: Context<AppEnv>, next: Next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)

  await ensureAdminToken(c.env.MAVEN_KV, c.env.ADMIN_BOOTSTRAP_TOKEN)

  await next()

  c.header('X-Request-Id', requestId)

  c.executionCtx.waitUntil(
    (async () => {
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

app.get('/*', handleFileGet)
app.head('/*', handleFileHead)
app.put('/*', handleFilePut)
app.delete('/*', handleFileDelete)

app.onError((error, c) => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  c.executionCtx.waitUntil(
    (async () => {
      const key = `stats:daily:${today}:errors`
      const current = await c.env.MAVEN_KV.get(key)
      await c.env.MAVEN_KV.put(key, String((Number(current) || 0) + 1))
      return undefined
    })()
  )

  return jsonError(c, toAppError(error))
})

app.notFound((c) => {
  return jsonError(c, notFound('Route not found'))
})

export default app
