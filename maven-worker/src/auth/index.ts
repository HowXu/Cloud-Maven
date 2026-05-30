import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { AccessToken, AppEnv } from '../env'
import { validateToken, hasPermission, createSession, deleteSession, getTokenBySession } from '../tokens'
import { getRepositoryPolicy } from '../config'
import { unauthorized, forbidden, jsonData, noContent } from '../shared'

export function parseXBasicHeader(header: string): { name: string; secret: string } | null {
  if (!header) return null

  const trimmed = header.trim()
  const [scheme, encoded] = trimmed.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'xbasic' || !encoded) return null

  try {
    const decoded = atob(encoded)
    const colonIndex = decoded.indexOf(':')
    if (colonIndex === -1) return null
    return {
      name: decoded.slice(0, colonIndex),
      secret: decoded.slice(colonIndex + 1),
    }
  } catch {
    return null
  }
}

function parseBearerHeader(header: string): string | null {
  const trimmed = header.trim()
  const [scheme, token] = trimmed.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token || null
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null

  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey === name) {
      return rawValue.join('=') || null
    }
  }

  return null
}

function getSessionId(c: Context<AppEnv>): string | null {
  const header = c.req.header('Authorization')
  if (header) {
    const bearer = parseBearerHeader(header)
    if (bearer) return bearer
  }

  return parseCookie(c.req.header('Cookie'), 'cloud_maven_session')
}

function sessionTtlSeconds(c: Context<AppEnv>): number {
  const configured = Number(c.env.SESSION_TTL_SECONDS)
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured)
  }
  return 86400
}

function sessionCookie(c: Context<AppEnv>, sessionId: string, maxAge: number): string {
  const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : ''
  return `cloud_maven_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function expiredSessionCookie(): string {
  return 'cloud_maven_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
}

function tokenDetails(token: AccessToken) {
  const roles: string[] = []
  if (token.permissions.some(p => p.actions.includes('manage'))) {
    roles.push('manager')
  }
  if (token.permissions.some(p => p.actions.includes('write'))) {
    roles.push('publisher')
  }

  return {
    token: {
      id: token.id,
      name: token.name,
      description: token.description,
      createdAt: token.createdAt,
    },
    roles,
    permissions: token.permissions,
  }
}

function parseBasicHeader(header: string): { name: string; secret: string } | null {
  const trimmed = header.trim()
  const [scheme, encoded] = trimmed.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return null

  try {
    const decoded = atob(encoded)
    const colonIndex = decoded.indexOf(':')
    if (colonIndex === -1) return null
    return {
      name: decoded.slice(0, colonIndex),
      secret: decoded.slice(colonIndex + 1),
    }
  } catch {
    return null
  }
}

export async function parseToken(c: Context<AppEnv>): Promise<AccessToken | null> {
  if (!c.env.MAVEN_KV) return null
  const header = c.req.header('Authorization')
  if (header) {
    const xBasic = parseXBasicHeader(header)
    if (xBasic) {
      return validateToken(c.env.MAVEN_KV, xBasic.name, xBasic.secret)
    }
    const basic = parseBasicHeader(header)
    if (basic) {
      return validateToken(c.env.MAVEN_KV, basic.name, basic.secret)
    }
  }

  const sessionId = getSessionId(c)
  if (!sessionId) return null
  return getTokenBySession(c.env.MAVEN_KV, sessionId)
}

export function auth(opts?: {
  permission?: string
  allowAnonymousRead?: boolean
}) {
  return async (c: Context<AppEnv>, next: Next) => {
    const token = await parseToken(c)

    if (token) {
      c.set('token', {
        id: token.id,
        name: token.name,
        permissions: token.permissions,
      })
    }

    if (!token) {
      if (opts?.allowAnonymousRead && opts?.permission === 'read') {
        const policy = await getRepositoryPolicy(c.env.MAVEN_KV)
        if (!policy || policy.visibility === 'PUBLIC') return next()
      }
      throw unauthorized()
    }

    if (opts?.permission) {
      if (!hasPermission(token.permissions, c.req.path, opts.permission)) {
        throw forbidden()
      }
    }

    await next()
  }
}

export const authApiRoutes = new Hono<AppEnv>()

authApiRoutes.post('/login', async (c) => {
  if (!c.env.MAVEN_KV) throw unauthorized()
  const body = await c.req.json<{ name?: string; secret?: string }>().catch(() => null)
  if (!body || !body.name || !body.secret) throw unauthorized()

  const token = await validateToken(c.env.MAVEN_KV, body.name, body.secret)
  if (!token) throw unauthorized()
  if (token.disabled) throw forbidden('Token is disabled')

  const ttl = sessionTtlSeconds(c)
  const session = await createSession(c.env.MAVEN_KV, token, ttl)
  c.header('Set-Cookie', sessionCookie(c, session.id, ttl))

  return jsonData(c, {
    ...tokenDetails(token),
    session: {
      token: session.id,
      expiresAt: session.expiresAt,
    },
  })
})

authApiRoutes.get('/me', async (c) => {
  const token = await parseToken(c)
  if (!token) throw unauthorized()

  if (token.disabled) throw forbidden('Token is disabled')

  return jsonData(c, tokenDetails(token))
})

authApiRoutes.get('/session', async (c) => {
  const token = await parseToken(c)
  if (!token) throw unauthorized()

  return jsonData(c, tokenDetails(token))
})

authApiRoutes.post('/logout', async (c) => {
  const sessionId = getSessionId(c)
  if (sessionId && c.env.MAVEN_KV) {
    await deleteSession(c.env.MAVEN_KV, sessionId)
  }
  c.header('Set-Cookie', expiredSessionCookie())
  return noContent(c)
})
