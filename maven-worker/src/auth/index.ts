import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import type { AppEnv } from '../env'
import { validateToken, hasPermission } from '../tokens'
import { getRepositoryPolicy } from '../config'
import { unauthorized, forbidden, jsonData, noContent } from '../shared'

export function parseXBasicHeader(header: string): { name: string; secret: string } | null {
  if (!header) return null

  const trimmed = header.trim()
  if (!trimmed.toLowerCase().startsWith('xbasic') || trimmed.length < 7) return null

  const encoded = trimmed.slice(6).trim()
  if (!encoded) return null

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

export async function parseToken(c: Context<AppEnv>) {
  const header = c.req.header('Authorization')
  if (!header) return null

  const parsed = parseXBasicHeader(header)
  if (!parsed) return null

  return validateToken(c.env.MAVEN_KV, parsed.name, parsed.secret)
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
        if (policy.visibility === 'PUBLIC') return next()
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

authApiRoutes.get('/me', async (c) => {
  const token = await parseToken(c)
  if (!token) throw unauthorized()

  if (token.disabled) throw forbidden('Token is disabled')

  const roles: string[] = []
  if (token.permissions.some(p => p.actions.includes('manage'))) {
    roles.push('manager')
  }
  if (token.permissions.some(p => p.actions.includes('write'))) {
    roles.push('publisher')
  }

  return jsonData(c, {
    token: {
      id: token.id,
      name: token.name,
      description: token.description,
      createdAt: token.createdAt,
    },
    roles,
    permissions: token.permissions,
  })
})

authApiRoutes.post('/logout', (c) => {
  return noContent(c)
})
