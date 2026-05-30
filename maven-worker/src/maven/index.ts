import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AccessPermission, AppEnv, TokenInfo } from '../env'
import { parseToken } from '../auth'
import { hasPermission } from '../tokens'
import { getRepositoryPolicy } from '../config'
import { getObject, headObject, putObject, deleteObject, listObjects, deleteObjectsByPrefix } from '../storage'
import { badRequest, conflict, forbidden, jsonData, notFound, unauthorized } from '../shared'
import {
  getContentType,
  getCacheControl,
  normalizeMavenPath,
  getParentPath,
  md5Hex,
  sha1Hex,
  isChecksumFile,
} from '../shared'

type MavenMetadata = {
  groupId?: string
  artifactId?: string
  latest?: string
  release?: string
  versions: string[]
  lastUpdated?: string
}

function extractMavenPath(c: Context<AppEnv>): string {
  const raw = c.req.path
  return raw.startsWith('/') ? raw.slice(1) : raw
}

async function tryParseToken(c: Context<AppEnv>): Promise<TokenInfo | null> {
  const existing = c.get('token')
  if (existing) return existing

  const token = await parseToken(c)
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
  if (!c.env.MAVEN_KV || !c.env.MAVEN_BUCKET) {
    throw unauthorized()
  }

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
  if (!c.env.MAVEN_KV || !c.env.MAVEN_BUCKET) {
    throw unauthorized()
  }
  const token = await tryParseToken(c)
  if (!token) throw unauthorized()
  if (!hasPermission(token.permissions, path.startsWith('/') ? path : `/${path}`, 'write')) {
    throw forbidden()
  }
  return token
}

async function ensureDeleteAccess(c: Context<AppEnv>, path: string): Promise<TokenInfo> {
  if (!c.env.MAVEN_KV || !c.env.MAVEN_BUCKET) {
    throw unauthorized()
  }
  const token = await tryParseToken(c)
  if (!token) throw unauthorized()
  if (!hasPermission(token.permissions, path.startsWith('/') ? path : `/${path}`, 'delete')) {
    throw forbidden()
  }
  return token
}

function isSnapshotPath(path: string): boolean {
  return /SNAPSHOT/i.test(path)
}

async function ensureRedeployAllowed(c: Context<AppEnv>, path: string): Promise<void> {
  if (!c.env.MAVEN_KV || !c.env.MAVEN_BUCKET) return
  const policy = await getRepositoryPolicy(c.env.MAVEN_KV)
  const existing = await headObject(c.env.MAVEN_BUCKET, path)
  if (!existing) return

  if (!isSnapshotPath(path) && !policy.allowReleaseRedeploy) {
    throw conflict('Release artifact already exists and redeploy is disabled')
  }

  if (isSnapshotPath(path) && !policy.allowSnapshotRedeploy) {
    throw conflict('Snapshot artifact already exists and redeploy is disabled')
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function validateCoordinatePart(name: string, value: string, pattern = /^[A-Za-z0-9_.-]+$/): void {
  if (!pattern.test(value)) {
    throw badRequest(`${name} contains unsupported characters`)
  }
}

function buildPomXml(input: {
  groupId: string
  artifactId: string
  version: string
  packaging?: string
  name?: string
  description?: string
}): string {
  const packaging = input.packaging || 'jar'
  const optionalName = input.name ? `\n  <name>${xmlEscape(input.name)}</name>` : ''
  const optionalDescription = input.description
    ? `\n  <description>${xmlEscape(input.description)}</description>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${xmlEscape(input.groupId)}</groupId>
  <artifactId>${xmlEscape(input.artifactId)}</artifactId>
  <version>${xmlEscape(input.version)}</version>
  <packaging>${xmlEscape(packaging)}</packaging>${optionalName}${optionalDescription}
</project>
`
}

function getGeneratedPomPath(
  rawPath: string,
  coordinates: { groupId: string; artifactId: string; version: string }
): string {
  const normalized = normalizeMavenPath(rawPath, { allowRoot: true })
  if (!normalized.isRoot) {
    if (normalized.value.endsWith('.pom')) {
      return normalized.value
    }

    return `${normalized.value}/${coordinates.artifactId}-${coordinates.version}.pom`
  }

  const groupPath = coordinates.groupId.replace(/\./g, '/')
  return `${groupPath}/${coordinates.artifactId}/${coordinates.version}/${coordinates.artifactId}-${coordinates.version}.pom`
}

function getTagValue(xml: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'i').exec(xml)
  return match?.[1]?.trim()
}

function getTagValues(xml: string, tagName: string): string[] {
  return Array.from(xml.matchAll(new RegExp(`<${tagName}>\\s*([^<]+?)\\s*</${tagName}>`, 'gi')))
    .map(match => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
}

function isSnapshotVersion(v: string): boolean {
  return /-SNAPSHOT$/i.test(v)
}

function versionCompare(a: string, b: string): number {
  const cleanA = a.replace(/-SNAPSHOT$/i, '').split(/[._-]/).map(p => Number(p) || 0)
  const cleanB = b.replace(/-SNAPSHOT$/i, '').split(/[._-]/).map(p => Number(p) || 0)
  const maxLen = Math.max(cleanA.length, cleanB.length)
  for (let i = 0; i < maxLen; i++) {
    const nA = cleanA[i] ?? 0
    const nB = cleanB[i] ?? 0
    if (nA !== nB) return nA - nB
  }
  return 0
}

export function parseMavenMetadata(xml: string): MavenMetadata {
  const versions = getTagValues(xml, 'version')
  const releaseVersions = versions.filter(v => !isSnapshotVersion(v))
  const sorted = [...releaseVersions].sort(versionCompare)

  const latestTag = getTagValue(xml, 'latest')
  const releaseTag = getTagValue(xml, 'release')

  return {
    groupId: getTagValue(xml, 'groupId'),
    artifactId: getTagValue(xml, 'artifactId'),
    latest: latestTag || sorted[sorted.length - 1],
    release: releaseTag || sorted[sorted.length - 1],
    versions,
    lastUpdated: getTagValue(xml, 'lastUpdated'),
  }
}

async function readMetadata(c: Context<AppEnv>, path: string): Promise<MavenMetadata> {
  if (!c.env.MAVEN_KV || !c.env.MAVEN_BUCKET) {
    throw notFound()
  }
  const metadataPath = path.endsWith('/maven-metadata.xml') || path === 'maven-metadata.xml'
    ? path
    : `${path}/maven-metadata.xml`
  await ensureReadAccess(c, metadataPath)

  const obj = await getObject(c.env.MAVEN_BUCKET, metadataPath)
  if (!obj) throw notFound('Maven metadata not found')

  const source = await obj.text()
  return parseMavenMetadata(source)
}

async function deleteMavenPrefix(c: Context<AppEnv>, path: string): Promise<number> {
  if (!c.env.MAVEN_BUCKET) throw notFound()
  const prefix = path.endsWith('/') ? path : `${path}/`
  const firstPage = await listObjects(c.env.MAVEN_BUCKET, prefix, undefined, 1)
  if (firstPage.objects.length === 0) {
    throw notFound()
  }

  return deleteObjectsByPrefix(c.env.MAVEN_BUCKET, prefix)
}

export async function handleFileGet(c: Context<AppEnv>): Promise<Response> {
  if (!c.env.MAVEN_BUCKET) return c.notFound()
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
  if (!c.env.MAVEN_BUCKET) return c.notFound()
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
  if (!c.env.MAVEN_BUCKET) throw badRequest('Storage not configured')
  const mavenPath = extractMavenPath(c)
  normalizeMavenPath(mavenPath)

  await ensureWriteAccess(c, mavenPath)
  await ensureRedeployAllowed(c, mavenPath)

  const contentType = c.req.header('Content-Type') || getContentType(mavenPath)
  const wantsChecksums = c.req.header('X-Generate-Checksums') === 'true' && !isChecksumFile(mavenPath)

  let obj: Awaited<ReturnType<typeof putObject>>
  let checksums: Record<string, string> = {}

  if (wantsChecksums) {
    const arrayBuffer = await c.req.raw.arrayBuffer()
    obj = await putObject(c.env.MAVEN_BUCKET, mavenPath, arrayBuffer, {
      httpMetadata: { contentType },
    })

    const [sha1, md5] = await Promise.all([
      sha1Hex(arrayBuffer),
      Promise.resolve(md5Hex(arrayBuffer)),
    ])
    checksums = { sha1, md5 }

    c.executionCtx.waitUntil(
      Promise.all([
        putObject(c.env.MAVEN_BUCKET, `${mavenPath}.sha1`, sha1, {
          httpMetadata: { contentType: 'text/plain' },
        }),
        putObject(c.env.MAVEN_BUCKET, `${mavenPath}.md5`, md5, {
          httpMetadata: { contentType: 'text/plain' },
        }),
      ]).then(() => undefined)
    )
  } else {
    const body = c.req.raw.body
    if (!body) throw badRequest('Request body is required')

    obj = await putObject(c.env.MAVEN_BUCKET, mavenPath, body, {
      httpMetadata: { contentType },
    })
  }

  const response: Record<string, unknown> = {
    path: mavenPath,
    size: obj.size,
    checksums,
  }

  return jsonData(c, response, 201)
}

export async function handleFileDelete(c: Context<AppEnv>): Promise<Response> {
  if (!c.env.MAVEN_BUCKET) throw badRequest('Storage not configured')
  const mavenPath = extractMavenPath(c)
  normalizeMavenPath(mavenPath)

  await ensureDeleteAccess(c, mavenPath)

  const obj = await headObject(c.env.MAVEN_BUCKET, mavenPath)
  if (!obj) {
    const deletedCount = await deleteMavenPrefix(c, mavenPath)
    return jsonData(c, {
      deleted: true,
      path: mavenPath,
      type: 'DIRECTORY',
      deletedCount,
    })
  }

  await deleteObject(c.env.MAVEN_BUCKET, mavenPath)
  if (!isChecksumFile(mavenPath)) {
    await Promise.all([
      deleteObject(c.env.MAVEN_BUCKET, `${mavenPath}.sha1`),
      deleteObject(c.env.MAVEN_BUCKET, `${mavenPath}.md5`),
      deleteObject(c.env.MAVEN_BUCKET, `${mavenPath}.sha256`),
      deleteObject(c.env.MAVEN_BUCKET, `${mavenPath}.sha512`),
    ])
  }

  return jsonData(c, {
    deleted: true,
    path: mavenPath,
    type: 'FILE',
    deletedCount: 1,
  })
}

function checkPerms(permissions: AccessPermission[] | undefined | null, entryPath: string, isPublicRead: boolean) {
  const permsArray = permissions ?? []
  const canRead = isPublicRead || hasPermission(permsArray, entryPath.startsWith('/') ? entryPath : `/${entryPath}`, 'read')
  const canWrite = hasPermission(permsArray, entryPath.startsWith('/') ? entryPath : `/${entryPath}`, 'write')
  const canDelete = hasPermission(permsArray, entryPath.startsWith('/') ? entryPath : `/${entryPath}`, 'delete')
  return { read: canRead, write: canWrite, delete: canDelete }
}

export const mavenApiRoutes = new Hono<AppEnv>()

mavenApiRoutes.post('/generate/pom', async (c) => {
  return generatePom(c, '')
})

mavenApiRoutes.post('/generate/pom/:path{.*}', async (c) => {
  return generatePom(c, c.req.param('path') || '')
})

mavenApiRoutes.get('/versions/:path{.*}', async (c) => {
  const rawPath = c.req.param('path') || ''
  const normalized = normalizeMavenPath(rawPath)
  const metadata = await readMetadata(c, normalized.value)
  const metadataPath = normalized.value.endsWith('/maven-metadata.xml') || normalized.value === 'maven-metadata.xml'
    ? normalized.value
    : `${normalized.value}/maven-metadata.xml`

  return jsonData(c, {
    path: normalized.value,
    metadataPath,
    ...metadata,
  })
})

mavenApiRoutes.delete('/artifacts/:path{.*}', async (c) => {
  const rawPath = c.req.param('path') || ''
  const normalized = normalizeMavenPath(rawPath)

  await ensureDeleteAccess(c, normalized.value)
  const deletedCount = await deleteMavenPrefix(c, normalized.value)

  return jsonData(c, {
    deleted: true,
    path: normalized.value,
    type: 'DIRECTORY',
    deletedCount,
  })
})

async function generatePom(c: Context<AppEnv>, rawPath: string): Promise<Response> {
  const body = await c.req.json<{
    groupId?: string
    artifactId?: string
    version?: string
    packaging?: string
    name?: string
    description?: string
  }>().catch(() => null)

  if (!body || !body.groupId || !body.artifactId || !body.version) {
    throw badRequest('groupId, artifactId and version are required')
  }
  validateCoordinatePart('groupId', body.groupId)
  validateCoordinatePart('artifactId', body.artifactId)
  validateCoordinatePart('version', body.version, /^[A-Za-z0-9_.+-]+$/)
  if (body.packaging) {
    validateCoordinatePart('packaging', body.packaging)
  }

  const pomPath = getGeneratedPomPath(rawPath, {
    groupId: body.groupId,
    artifactId: body.artifactId,
    version: body.version,
  })

  normalizeMavenPath(pomPath)
  await ensureWriteAccess(c, pomPath)
  await ensureRedeployAllowed(c, pomPath)

  const bucket = c.env.MAVEN_BUCKET
  if (!bucket) throw badRequest('Storage not configured')

  const pom = buildPomXml({
    groupId: body.groupId,
    artifactId: body.artifactId,
    version: body.version,
    packaging: body.packaging,
    name: body.name,
    description: body.description,
  })

  const obj = await putObject(bucket, pomPath, pom, {
    httpMetadata: { contentType: 'application/xml; charset=utf-8' },
  })

  return jsonData(c, {
    path: pomPath,
    size: obj.size,
  }, 201)
}

async function details(c: Context<AppEnv>): Promise<Response> {
  if (!c.env.MAVEN_BUCKET) return jsonData(c, { path: '', parentPath: null, entries: [], canRead: false, canWrite: false })
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
}

mavenApiRoutes.get('/details', details)
mavenApiRoutes.get('/details/:path{.*}', details)
