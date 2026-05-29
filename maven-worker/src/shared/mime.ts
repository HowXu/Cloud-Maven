const MIME_TABLE: Record<string, string> = {
  '.jar': 'application/java-archive',
  '.pom': 'application/xml',
  '.xml': 'application/xml',
  '.sha1': 'text/plain',
  '.md5': 'text/plain',
  '.sha256': 'text/plain',
  '.sha512': 'text/plain',
  '.asc': 'application/pgp-signature',
  '.module': 'application/json',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.ear': 'application/java-archive',
  '.war': 'application/java-archive',
  '.aar': 'application/java-archive',
  '.apk': 'application/vnd.android.package-archive',
}

export function getContentType(path: string): string {
  const lastDot = path.lastIndexOf('.')
  if (lastDot === -1) return 'application/octet-stream'
  return MIME_TABLE[path.slice(lastDot).toLowerCase()] ?? 'application/octet-stream'
}

export function isSnapshotArtifact(path: string): boolean {
  const parts = path.split('/')
  for (const part of parts) {
    if (/SNAPSHOT/i.test(part)) return true
  }
  return false
}

export function getCacheControl(path: string): string {
  const filename = path.split('/').pop() ?? ''
  if (filename === 'maven-metadata.xml') return 'no-cache'
  if (isSnapshotArtifact(path)) return 'no-cache'
  return 'public, max-age=31536000, immutable'
}

export function isChecksumFile(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  return /\.(sha1|md5|sha256|sha512)$/i.test(name)
}

export function isMetadataFile(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  return name === 'maven-metadata.xml'
}
