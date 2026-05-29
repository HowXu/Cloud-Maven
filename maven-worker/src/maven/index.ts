import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, TokenInfo } from '../env'
import { parseXBasicHeader } from '../auth'
import { validateToken, hasPermission } from '../tokens'
import { getRepositoryPolicy } from '../config'
import { getObject, headObject, putObject, deleteObject, listObjects } from '../storage'
import { badRequest, conflict, forbidden, jsonData, notFound, unauthorized } from '../shared'
import {
  getContentType,
  getCacheControl,
  normalizeMavenPath,
  getParentPath,
} from '../shared'

function extractMavenPath(c: Context<AppEnv>): string {
  const raw = c.req.path
  return raw.startsWith('/') ? raw.slice(1) : raw
}

async function tryParseToken(c: Context<AppEnv>): Promise<TokenInfo | null> {
  const existing = c.get('token')
  if (existing) return existing

  const header = c.req.header('Authorization')
  if (!header) return null

  const parsed = parseXBasicHeader(header)
  if (!parsed) return null

  const token = await validateToken(c.env.MAVEN_KV, parsed.name, parsed.secret)
  if (!token || token.disabled) return null

  const info: TokenInfo = {
    id: token.id,
    name: token.name,
    permissions: token.permissions,
  }
  c.set('token', info)
  return info
}

async function ensureReadAccess(c: Context<AppEnv>, path: string): Promise<TokenInfo | null> {
  const token = await tryParseToken(c)
  if (token) {
    if (!hasPermission(token.permissions, path.startsWith('/') ? path : `/${path}`, 'read')) {
      throw forbidden()
    }
    return token
  }

  const policy = await getRepositoryPolicy(c.env.MAVEN_KV)
  if (policy.visibility !== 'PUBLIC') {
    throw unauthorized()
  }

  return null
}

async function ensureWriteAccess(c: Context<AppEnv>, path: string): Promise<TokenInfo> {
  const token = await tryParseToken(c)
  if (!token) throw unauthorized()
  if (!hasPermission(token.permissions, path.startsWith('/') ? path : `/${path}`, 'write')) {
    throw forbidden()
  }
  return token
}

async function ensureDeleteAccess(c: Context<AppEnv>, path: string): Promise<TokenInfo> {
  const token = await tryParseToken(c)
  if (!token) throw unauthorized()
  if (!hasPermission(token.permissions, path.startsWith('/') ? path : `/${path}`, 'delete')) {
    throw forbidden()
  }
  return token
}

export async function handleFileGet(c: Context<AppEnv>): Promise<Response> {
  const mavenPath = extractMavenPath(c)

  try {
    normalizeMavenPath(mavenPath)
  } catch {
    return c.notFound()
  }

  await ensureReadAccess(c, mavenPath)

  const obj = await getObject(c.env.MAVEN_BUCKET, mavenPath)
  if (!obj) throw notFound()

  const headers = new Headers()
  headers.set('Content-Type', getContentType(mavenPath))
  headers.set('Cache-Control', getCacheControl(mavenPath))
  headers.set('ETag', obj.httpEtag || `"${obj.uploaded.getTime()}"`)
  headers.set('Content-Length', String(obj.size))

  return new Response(obj.body, {
    status: 200,
    headers,
  })
}

export async function handleFileHead(c: Context<AppEnv>): Promise<Response> {
  const mavenPath = extractMavenPath(c)

  try {
    normalizeMavenPath(mavenPath)
  } catch {
    return c.notFound()
  }

  await ensureReadAccess(c, mavenPath)

  const obj = await headObject(c.env.MAVEN_BUCKET, mavenPath)
  if (!obj) throw notFound()

  const headers = new Headers()
  headers.set('Content-Type', getContentType(mavenPath))
  headers.set('Cache-Control', getCacheControl(mavenPath))
  headers.set('ETag', obj.httpEtag || `"${obj.uploaded.getTime()}"`)
  headers.set('Content-Length', String(obj.size))

  return new Response(null, {
    status: 200,
    headers,
  })
}

export async function handleFilePut(c: Context<AppEnv>): Promise<Response> {
  const mavenPath = extractMavenPath(c)
  normalizeMavenPath(mavenPath)

  await ensureWriteAccess(c, mavenPath)

  const policy = await getRepositoryPolicy(c.env.MAVEN_KV)

  const isSnapshot = /SNAPSHOT/i.test(mavenPath)
  if (!isSnapshot && !policy.allowReleaseRedeploy) {
    const existing = await headObject(c.env.MAVEN_BUCKET, mavenPath)
    if (existing) throw conflict('Release artifact already exists and redeploy is disabled')
  }
  if (isSnapshot && !policy.allowSnapshotRedeploy) {
    const existing = await headObject(c.env.MAVEN_BUCKET, mavenPath)
    if (existing) throw conflict('Snapshot artifact already exists and redeploy is disabled')
  }

  const body = c.req.raw.body
  if (!body) throw badRequest('Request body is required')

  const contentType = c.req.header('Content-Type') || getContentType(mavenPath)

  const obj = await putObject(c.env.MAVEN_BUCKET, mavenPath, body, {
    httpMetadata: { contentType },
  })

  const response: Record<string, unknown> = {
    path: mavenPath,
    size: obj.size,
    checksums: {},
  }

  if (c.req.header('X-Generate-Checksums') === 'true') {
    const arrayBuffer = await c.req.raw.clone().arrayBuffer()
    const sha1Hash = await crypto.subtle.digest('SHA-1', arrayBuffer)
    const md5Hash = await crypto.subtle.digest('MD5', arrayBuffer)

    const sha1Hex = Array.from(new Uint8Array(sha1Hash))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    const md5Hex = Array.from(new Uint8Array(md5Hash))
      .map(b => b.toString(16).padStart(2, '0')).join('')

    response.checksums = { sha1: sha1Hex, md5: md5Hex }

    c.executionCtx.waitUntil(
      Promise.all([
        putObject(c.env.MAVEN_BUCKET, `${mavenPath}.sha1`, sha1Hex, {
          httpMetadata: { contentType: 'text/plain' },
        }),
        putObject(c.env.MAVEN_BUCKET, `${mavenPath}.md5`, md5Hex, {
          httpMetadata: { contentType: 'text/plain' },
        }),
      ])
    )
  }

  return jsonData(c, response, 201)
}

export async function handleFileDelete(c: Context<AppEnv>): Promise<Response> {
  const mavenPath = extractMavenPath(c)
  normalizeMavenPath(mavenPath)

  await ensureDeleteAccess(c, mavenPath)

  const obj = await headObject(c.env.MAVEN_BUCKET, mavenPath)
  if (!obj) throw notFound()

  await deleteObject(c.env.MAVEN_BUCKET, mavenPath)

  return jsonData(c, {
    deleted: true,
    path: mavenPath,
  })
}

function checkPerms(permissions: typeof import('../env').AccessPermission[] | undefined | null, entryPath: string, isPublicRead: boolean) {
  const permsArray = permissions ?? []
  const canRead = isPublicRead || hasPermission(permsArray, entryPath.startsWith('/') ? entryPath : `/${entryPath}`, 'read')
  const canWrite = hasPermission(permsArray, entryPath.startsWith('/') ? entryPath : `/${entryPath}`, 'write')
  const canDelete = hasPermission(permsArray, entryPath.startsWith('/') ? entryPath : `/${entryPath}`, 'delete')
  return { read: canRead, write: canWrite, delete: canDelete }
}

export const mavenApiRoutes = new Hono<AppEnv>()

mavenApiRoutes.get('/details/:path{.*}', async (c) => {
  const rawPath = c.req.param('path') || ''
  const normalized = normalizeMavenPath(rawPath, { allowRoot: true })

  const token = await tryParseToken(c)

  const policy = await getRepositoryPolicy(c.env.MAVEN_KV)
  if (!token && policy.visibility !== 'PUBLIC') {
    throw unauthorized()
  }

  const isPublicRead = policy.visibility === 'PUBLIC'
  const tokenPerms = token?.permissions

  const prefix = normalized.isRoot ? '' : `${normalized.value}/`
  const result = await listObjects(c.env.MAVEN_BUCKET, prefix, '/')

  const entries: Array<{
    name: string
    path: string
    type: 'DIRECTORY' | 'FILE'
    size?: number
    updatedAt?: string
    contentType?: string
    permissions: { read: boolean; write: boolean; delete: boolean }
  }> = []

  for (const prefix of result.delimitedPrefixes) {
    const dirPath = prefix.slice(0, -1)
    const dirName = dirPath.split('/').pop() ?? dirPath
    entries.push({
      name: dirName,
      path: dirPath,
      type: 'DIRECTORY',
      permissions: checkPerms(tokenPerms, dirPath, isPublicRead),
    })
  }

  for (const obj of result.objects) {
    const objName = obj.key.split('/').pop() ?? obj.key
    if (!objName) continue
    entries.push({
      name: objName,
      path: obj.key,
      type: 'FILE',
      size: obj.size,
      updatedAt: obj.uploaded.toISOString(),
      contentType: obj.httpMetadata?.contentType ?? getContentType(obj.key),
      permissions: checkPerms(tokenPerms, obj.key, isPublicRead),
    })
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'DIRECTORY' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  let parentPath: string | null = null
  if (!normalized.isRoot) {
    const parent = getParentPath(normalized.value)
    parentPath = parent ?? ''
  }

  const rootPerms = checkPerms(tokenPerms, normalized.value || '/', isPublicRead)
  return jsonData(c, {
    path: normalized.value,
    parentPath,
    canRead: rootPerms.read,
    canWrite: rootPerms.write,
    entries,
  })
})
