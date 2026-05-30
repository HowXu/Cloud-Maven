import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import { createToken } from '../../src/tokens'
import type { AccessPermission, RepositoryPolicy } from '../../src/env'

const PUBLIC_POLICY: RepositoryPolicy = {
  visibility: 'PUBLIC',
  allowReleaseRedeploy: false,
  allowSnapshotRedeploy: true,
}

const requestUrl = (path: string) => `https://cloud-maven.test${path}`

const createAuthHeader = async (
  permissions: AccessPermission[] = [{ path: '/', actions: ['read', 'write', 'delete', 'manage'] }],
) => {
  const name = `token-${crypto.randomUUID()}`
  const secret = `secret-${crypto.randomUUID()}`
  const token = await createToken(env.MAVEN_KV!, name, secret, permissions, 'test token')
  return {
    token,
    secret,
    headers: {
      Authorization: `xBasic ${btoa(`${name}:${secret}`)}`,
    },
  }
}

describe('Worker auth and admin routes', () => {
  beforeEach(async () => {
    await env.MAVEN_KV!.put('config:repository', JSON.stringify(PUBLIC_POLICY))
  })

  it('creates a session with login and accepts bearer session authentication', async () => {
    const { token, secret } = await createAuthHeader()

    const login = await SELF.fetch(requestUrl('/api/auth/login'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: token.name,
        secret,
      }),
    })
    const loginBody = await login.json() as {
      token: { id: string; name: string }
      roles: string[]
      session: { token: string; expiresAt: string }
    }

    expect(login.status).toBe(200)
    expect(login.headers.get('Set-Cookie')).toContain('cloud_maven_session=')
    expect(loginBody.token).toMatchObject({
      id: token.id,
      name: token.name,
    })
    expect(loginBody.roles).toContain('manager')

    const session = await SELF.fetch(requestUrl('/api/auth/session'), {
      headers: {
        Authorization: `Bearer ${loginBody.session.token}`,
      },
    })

    expect(session.status).toBe(200)
    await expect(session.json()).resolves.toMatchObject({
      token: {
        id: token.id,
        name: token.name,
      },
    })

    const logout = await SELF.fetch(requestUrl('/api/auth/logout'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loginBody.session.token}`,
      },
    })
    expect(logout.status).toBe(204)

    const afterLogout = await SELF.fetch(requestUrl('/api/auth/session'), {
      headers: {
        Authorization: `Bearer ${loginBody.session.token}`,
      },
    })
    expect(afterLogout.status).toBe(401)
  })

  it('creates, updates, and deletes admin-managed tokens', async () => {
    const { headers } = await createAuthHeader()
    const tokenName = `publisher-${crypto.randomUUID()}`

    const created = await SELF.fetch(requestUrl('/api/admin/tokens'), {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: tokenName,
        description: 'CI publisher',
        permissions: [
          {
            path: 'com/example',
            actions: ['read', 'write', 'write'],
          },
        ],
      }),
    })
    const createdBody = await created.json() as {
      id: string
      name: string
      secret: string
      enabled: boolean
      permissions: AccessPermission[]
    }

    expect(created.status).toBe(201)
    expect(createdBody).toMatchObject({
      name: tokenName,
      enabled: true,
      permissions: [
        {
          path: '/com/example',
          actions: ['read', 'write'],
        },
      ],
    })
    expect(createdBody.secret.length).toBeGreaterThan(20)

    const updated = await SELF.fetch(requestUrl(`/api/admin/tokens/${createdBody.id}`), {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enabled: false,
        permissions: [
          {
            path: '/',
            actions: ['read'],
          },
        ],
      }),
    })

    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({
      id: createdBody.id,
      enabled: false,
      permissions: [
        {
          path: '/',
          actions: ['read'],
        },
      ],
    })

    const deleted = await SELF.fetch(requestUrl(`/api/admin/tokens/${createdBody.id}`), {
      method: 'DELETE',
      headers,
    })

    expect(deleted.status).toBe(204)
  })

  it('rotates token secret via PUT /api/admin/tokens/:id', async () => {
    const { headers } = await createAuthHeader()
    const { secret: originalSecret } = await createAuthHeader()

    const created = await SELF.fetch(requestUrl('/api/admin/tokens'), {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `rotate-${crypto.randomUUID()}`,
        permissions: [{ path: '/', actions: ['read'] }],
      }),
    })
    const createdBody = await created.json() as { id: string; secret: string }

    const newSecret = `new-secret-${crypto.randomUUID()}`
    const updated = await SELF.fetch(requestUrl(`/api/admin/tokens/${createdBody.id}`), {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: newSecret,
      }),
    })

    expect(updated.status).toBe(200)
    const updatedBody = await updated.json() as { secret: string }
    expect(updatedBody.secret).toBe(newSecret)
    expect(updatedBody.secret).not.toBe(createdBody.secret)
  })

  it('updates and retrieves repository settings via PUT /api/admin/settings', async () => {
    const { headers } = await createAuthHeader()

    const updated = await SELF.fetch(requestUrl('/api/admin/settings'), {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Updated Repo Title',
        baseUrl: 'https://updated.example.com',
        defaultRepository: 'releases',
        anonymousRead: false,
        allowOverwrite: true,
        generateChecksums: true,
        maintainMetadata: true,
      }),
    })

    expect(updated.status).toBe(200)
    const updatedBody = await updated.json() as {
      title: string
      baseUrl: string
      defaultRepository: string
      anonymousRead: boolean
      allowOverwrite: boolean
      generateChecksums: boolean
      maintainMetadata: boolean
    }
    expect(updatedBody.title).toBe('Updated Repo Title')
    expect(updatedBody.anonymousRead).toBe(false)
    expect(updatedBody.allowOverwrite).toBe(true)
    expect(updatedBody.generateChecksums).toBe(true)
    expect(updatedBody.maintainMetadata).toBe(true)

    const fetched = await SELF.fetch(requestUrl('/api/admin/settings'), { headers })
    await expect(fetched.json()).resolves.toMatchObject({
      title: 'Updated Repo Title',
      anonymousRead: false,
    })
  })

  it('rejects unsupported admin token permission actions', async () => {
    const { headers } = await createAuthHeader()

    const response = await SELF.fetch(requestUrl('/api/admin/tokens'), {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `bad-${crypto.randomUUID()}`,
        permissions: [
          {
            path: '/',
            actions: ['read', 'publish'],
          },
        ],
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Unsupported permission action: publish',
    })
  })

  it('returns admin stats using R2 object summaries', async () => {
    const { headers } = await createAuthHeader()
    const prefix = `stats-${crypto.randomUUID()}`
    await env.MAVEN_BUCKET!.put(`${prefix}/one.txt`, 'one')
    await env.MAVEN_BUCKET!.put(`${prefix}/two.txt`, 'two')

    const response = await SELF.fetch(requestUrl('/api/admin/stats'), {
      headers,
    })
    const body = await response.json() as {
      repositories: number
      objects: number
      storageBytes: number
      requests24h: number
      errors24h: number
    }

    expect(response.status).toBe(200)
    expect(body.repositories).toBe(1)
    expect(body.objects).toBeGreaterThanOrEqual(2)
    expect(body.storageBytes).toBeGreaterThanOrEqual(6)
    expect(body.requests24h).toBeGreaterThanOrEqual(0)
    expect(body.errors24h).toBeGreaterThanOrEqual(0)
  })
})
