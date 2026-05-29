import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { auth } from '../auth'
import { listTokens, createToken, getToken, updateToken, deleteToken } from '../tokens'
import { getRepositoryPolicy, getSettings, updateSettings } from '../config'
import { badRequest, jsonData, noContent } from '../shared'

const authManager = auth({ permission: 'manage' })

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.get('/stats', authManager, async (c) => {
  const kv = c.env.MAVEN_KV
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')

  const [reqsRaw, errsRaw] = await Promise.all([
    kv.get(`stats:daily:${today}:requests`),
    kv.get(`stats:daily:${today}:errors`),
  ])

  return jsonData(c, {
    repositories: 1,
    objects: 0,
    storageBytes: 0,
    requests24h: Number(reqsRaw) || 0,
    errors24h: Number(errsRaw) || 0,
  })
})

adminRoutes.get('/tokens', authManager, async (c) => {
  const tokens = await listTokens(c.env.MAVEN_KV)
  return jsonData(c, tokens.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    enabled: !t.disabled,
    createdAt: t.createdAt,
    permissions: t.permissions,
  })))
})

adminRoutes.post('/tokens', authManager, async (c) => {
  const body = await c.req.json<{
    name: string
    description?: string
    permissions?: Array<{ path: string; actions: string[] }>
  }>().catch(() => null)

  if (!body || !body.name) throw badRequest('Token name is required')

  const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')

  const token = await createToken(
    c.env.MAVEN_KV,
    body.name,
    secret,
    body.permissions ?? [{ path: '/', actions: ['read'] }],
    body.description,
  )

  return jsonData(c, {
    id: token.id,
    name: token.name,
    secret,
    description: token.description,
    enabled: !token.disabled,
    createdAt: token.createdAt,
    permissions: token.permissions,
  }, 201)
})

adminRoutes.put('/tokens/:id', authManager, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    description?: string
    enabled?: boolean
    permissions?: Array<{ path: string; actions: string[] }>
    secret?: string
  }>().catch(() => null)

  if (!body) throw badRequest('Invalid request body')

  const token = await updateToken(c.env.MAVEN_KV, id, {
    name: body.name,
    description: body.description,
    disabled: body.enabled !== undefined ? !body.enabled : undefined,
    permissions: body.permissions,
    secret: body.secret,
  })

  return jsonData(c, {
    id: token.id,
    name: token.name,
    description: token.description,
    enabled: !token.disabled,
    createdAt: token.createdAt,
    permissions: token.permissions,
  })
})

adminRoutes.delete('/tokens/:id', authManager, async (c) => {
  const id = c.req.param('id')
  await deleteToken(c.env.MAVEN_KV, id)
  return noContent(c)
})

adminRoutes.get('/settings', authManager, async (c) => {
  const policy = await getRepositoryPolicy(c.env.MAVEN_KV)
  const settings = await getSettings(c.env.MAVEN_KV)
  return jsonData(c, {
    title: settings.title,
    baseUrl: settings.baseUrl,
    defaultRepository: settings.defaultRepository,
    anonymousRead: policy.visibility === 'PUBLIC',
    allowOverwrite: policy.allowReleaseRedeploy,
    generateChecksums: settings.generateChecksums,
    maintainMetadata: settings.maintainMetadata,
  })
})

adminRoutes.put('/settings', authManager, async (c) => {
  const body = await c.req.json<{
    title?: string
    baseUrl?: string
    defaultRepository?: string
    anonymousRead?: boolean
    allowOverwrite?: boolean
    generateChecksums?: boolean
    maintainMetadata?: boolean
  }>().catch(() => null)

  if (!body) throw badRequest('Invalid request body')

  const settings = await updateSettings(c.env.MAVEN_KV, body)

  const policy = await getRepositoryPolicy(c.env.MAVEN_KV)

  return jsonData(c, {
    title: settings.title,
    baseUrl: settings.baseUrl,
    defaultRepository: settings.defaultRepository,
    anonymousRead: policy.visibility === 'PUBLIC',
    allowOverwrite: policy.allowReleaseRedeploy,
    generateChecksums: settings.generateChecksums,
    maintainMetadata: settings.maintainMetadata,
  })
})
