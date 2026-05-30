import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import { createToken } from '../../src/tokens'
import type { AccessPermission, RepositoryPolicy } from '../../src/env'

const PUBLIC_POLICY: RepositoryPolicy = {
  visibility: 'PUBLIC',
  allowReleaseRedeploy: false,
  allowSnapshotRedeploy: true,
}

const PRIVATE_POLICY: RepositoryPolicy = {
  ...PUBLIC_POLICY,
  visibility: 'PRIVATE',
}

const requestUrl = (path: string) => `https://cloud-maven.test${path}`

const setPolicy = (policy: RepositoryPolicy) =>
  env.MAVEN_KV!.put('config:repository', JSON.stringify(policy))

const createAuthHeader = async (
  permissions: AccessPermission[] = [{ path: '/', actions: ['read', 'write', 'delete', 'manage'] }],
) => {
  const name = `token-${crypto.randomUUID()}`
  const secret = `secret-${crypto.randomUUID()}`
  await createToken(env.MAVEN_KV!, name, secret, permissions)
  return {
    Authorization: `xBasic ${btoa(`${name}:${secret}`)}`,
  }
}

describe('Worker Maven routes', () => {
  beforeEach(async () => {
    await setPolicy(PUBLIC_POLICY)
  })

  it('reports Worker health', async () => {
    const response = await SELF.fetch(requestUrl('/api/status/health'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('streams public Maven files directly from R2', async () => {
    const path = `releases/com/example/demo/${crypto.randomUUID()}/demo.pom`
    await env.MAVEN_BUCKET!.put(path, '<project />', {
      httpMetadata: {
        contentType: 'application/xml',
      },
    })

    const response = await SELF.fetch(requestUrl(`/${path}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    await expect(response.text()).resolves.toBe('<project />')
  })

  it('returns directory details needed by the frontend browser', async () => {
    const base = `releases/com/example/demo-${crypto.randomUUID()}`
    await env.MAVEN_BUCKET!.put(`${base}/maven-metadata.xml`, '<metadata />', {
      httpMetadata: {
        contentType: 'application/xml',
      },
    })
    await env.MAVEN_BUCKET!.put(`${base}/1.0.0/demo-1.0.0.jar`, 'jar-content')

    const response = await SELF.fetch(requestUrl(`/api/maven/details/${base}`))
    const body = await response.json() as {
      path: string
      parentPath: string | null
      canRead: boolean
      canWrite: boolean
      entries: Array<{
        name: string
        path: string
        type: 'DIRECTORY' | 'FILE'
        size?: number
        contentType?: string
        permissions: { read: boolean; write: boolean; delete: boolean }
      }>
    }

    expect(response.status).toBe(200)
    expect(body.path).toBe(base)
    expect(body.parentPath).toBe('releases/com/example')
    expect(body.canRead).toBe(true)
    expect(body.canWrite).toBe(false)
    expect(body.entries).toEqual([
      expect.objectContaining({
        name: '1.0.0',
        path: `${base}/1.0.0`,
        type: 'DIRECTORY',
        permissions: {
          read: true,
          write: false,
          delete: false,
        },
      }),
      expect.objectContaining({
        name: 'maven-metadata.xml',
        path: `${base}/maven-metadata.xml`,
        type: 'FILE',
        contentType: 'application/xml',
        permissions: {
          read: true,
          write: false,
          delete: false,
        },
      }),
    ])
  })

  it('requires write permission for uploads', async () => {
    const path = `releases/com/example/demo/${crypto.randomUUID()}/demo.jar`

    const anonymous = await SELF.fetch(requestUrl(`/${path}`), {
      method: 'PUT',
      body: 'jar-content',
    })
    expect(anonymous.status).toBe(401)

    const readOnlyHeader = await createAuthHeader([{ path: '/', actions: ['read'] }])
    const readOnly = await SELF.fetch(requestUrl(`/${path}`), {
      method: 'PUT',
      headers: readOnlyHeader,
      body: 'jar-content',
    })
    expect(readOnly.status).toBe(403)
  })

  it('uploads with write permission and blocks release redeploys by default', async () => {
    const authHeader = await createAuthHeader()
    const path = `releases/com/example/demo/${crypto.randomUUID()}/demo-1.0.0.jar`

    const created = await SELF.fetch(requestUrl(`/${path}`), {
      method: 'PUT',
      headers: authHeader,
      body: 'jar-content',
    })
    const createdBody = await created.json() as { path: string; size: number; checksums: Record<string, string> }

    expect(created.status).toBe(201)
    expect(createdBody).toEqual({
      path,
      size: 'jar-content'.length,
      checksums: {},
    })
    const stored = await env.MAVEN_BUCKET!.get(path)
    expect(stored).not.toBeNull()
    await expect(stored!.text()).resolves.toBe('jar-content')

    const duplicate = await SELF.fetch(requestUrl(`/${path}`), {
      method: 'PUT',
      headers: authHeader,
      body: 'replacement',
    })

    expect(duplicate.status).toBe(409)
  })

  it('returns checksum values when checksum generation is requested', async () => {
    const authHeader = await createAuthHeader()
    const path = `releases/com/example/demo/${crypto.randomUUID()}/demo-1.0.0.jar`

    const response = await SELF.fetch(requestUrl(`/${path}`), {
      method: 'PUT',
      headers: {
        ...authHeader,
        'X-Generate-Checksums': 'true',
      },
      body: 'abc',
    })
    const body = await response.json() as { path: string; size: number; checksums: { sha1: string; md5: string } }

    expect(response.status).toBe(201)
    expect(body).toEqual({
      path,
      size: 3,
      checksums: {
        sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
        md5: '900150983cd24fb0d6963f7d28e17f72',
      },
    })
  })

  it('deletes files with delete permission', async () => {
    const authHeader = await createAuthHeader()
    const path = `releases/com/example/demo/${crypto.randomUUID()}/demo-1.0.0.jar`
    await env.MAVEN_BUCKET!.put(path, 'jar-content')

    const response = await SELF.fetch(requestUrl(`/${path}`), {
      method: 'DELETE',
      headers: authHeader,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      path,
      type: 'FILE',
      deletedCount: 1,
    })
    await expect(env.MAVEN_BUCKET!.get(path)).resolves.toBeNull()
  })

  it('deletes artifact directories via the artifacts API endpoint', async () => {
    const authHeader = await createAuthHeader()
    const base = `releases/com/example/demo-${crypto.randomUUID()}`
    const firstPath = `${base}/1.0.0/demo-1.0.0.jar`
    const secondPath = `${base}/1.0.0/demo-1.0.0.pom`
    await env.MAVEN_BUCKET!.put(firstPath, 'jar-content')
    await env.MAVEN_BUCKET!.put(secondPath, '<project />')

    const response = await SELF.fetch(requestUrl(`/api/maven/artifacts/${base}`), {
      method: 'DELETE',
      headers: authHeader,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      path: base,
      type: 'DIRECTORY',
      deletedCount: 2,
    })
    await expect(env.MAVEN_BUCKET!.get(firstPath)).resolves.toBeNull()
    await expect(env.MAVEN_BUCKET!.get(secondPath)).resolves.toBeNull()
  })

  it('deletes artifact directories by prefix', async () => {
    const authHeader = await createAuthHeader()
    const base = `releases/com/example/demo-${crypto.randomUUID()}`
    const firstPath = `${base}/1.0.0/demo-1.0.0.jar`
    const secondPath = `${base}/1.0.0/demo-1.0.0.pom`
    await env.MAVEN_BUCKET!.put(firstPath, 'jar-content')
    await env.MAVEN_BUCKET!.put(secondPath, '<project />')

    const response = await SELF.fetch(requestUrl(`/${base}`), {
      method: 'DELETE',
      headers: authHeader,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      path: base,
      type: 'DIRECTORY',
      deletedCount: 2,
    })
    await expect(env.MAVEN_BUCKET!.get(firstPath)).resolves.toBeNull()
    await expect(env.MAVEN_BUCKET!.get(secondPath)).resolves.toBeNull()
  })

  it('generates a minimal POM at the Maven coordinate path', async () => {
    const authHeader = await createAuthHeader()
    const response = await SELF.fetch(requestUrl('/api/maven/generate/pom'), {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        groupId: 'com.example',
        artifactId: 'demo',
        version: '1.0.0',
        name: 'Demo <Library>',
      }),
    })
    const body = await response.json() as { path: string; size: number }

    expect(response.status).toBe(201)
    expect(body.path).toBe('com/example/demo/1.0.0/demo-1.0.0.pom')

    const pom = await env.MAVEN_BUCKET!.get(body.path)
    expect(pom).not.toBeNull()
    await expect(pom!.text()).resolves.toContain('<name>Demo &lt;Library&gt;</name>')
  })

  it('reads Maven metadata through the versions helper endpoint', async () => {
    const base = `releases/com/example/demo-${crypto.randomUUID()}`
    await env.MAVEN_BUCKET!.put(`${base}/maven-metadata.xml`, `
      <metadata>
        <groupId>com.example</groupId>
        <artifactId>demo</artifactId>
        <versioning>
          <latest>1.1.0</latest>
          <release>1.0.0</release>
          <versions>
            <version>0.9.0</version>
            <version>1.0.0</version>
          </versions>
          <lastUpdated>20260529010101</lastUpdated>
        </versioning>
      </metadata>
    `)

    const response = await SELF.fetch(requestUrl(`/api/maven/versions/${base}`))
    const body = await response.json() as {
      path: string
      metadataPath: string
      groupId: string
      artifactId: string
      latest: string
      release: string
      versions: string[]
      lastUpdated: string
    }

    expect(response.status).toBe(200)
    expect(body).toEqual({
      path: base,
      metadataPath: `${base}/maven-metadata.xml`,
      groupId: 'com.example',
      artifactId: 'demo',
      latest: '1.1.0',
      release: '1.0.0',
      versions: ['0.9.0', '1.0.0'],
      lastUpdated: '20260529010101',
    })
  })

  it('denies anonymous reads when the repository policy is private', async () => {
    const path = `releases/com/example/demo/${crypto.randomUUID()}/demo.pom`
    await env.MAVEN_BUCKET!.put(path, '<project />')
    await setPolicy(PRIVATE_POLICY)

    const anonymous = await SELF.fetch(requestUrl(`/${path}`))
    expect(anonymous.status).toBe(401)

    const authHeader = await createAuthHeader([{ path: '/', actions: ['read'] }])
    const authorized = await SELF.fetch(requestUrl(`/${path}`), {
      headers: authHeader,
    })

    expect(authorized.status).toBe(200)
    await expect(authorized.text()).resolves.toBe('<project />')
  })
})
