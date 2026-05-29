export type RepositoryVisibility = 'PUBLIC' | 'PRIVATE' | 'HIDDEN'

export interface RepositoryPolicy {
  visibility: RepositoryVisibility
  allowReleaseRedeploy: boolean
  allowSnapshotRedeploy: boolean
}

export interface AccessPermission {
  path: string
  actions: Array<'read' | 'write' | 'delete' | 'manage'>
}

export interface AccessToken {
  id: string
  name: string
  secretHash: string
  salt: string
  description?: string
  createdAt: string
  expiresAt?: string
  disabled?: boolean
  permissions: AccessPermission[]
}

export interface ClientSettings {
  title: string
  baseUrl: string
  defaultRepository: string
  anonymousRead: boolean
  allowOverwrite: boolean
  generateChecksums: boolean
  maintainMetadata: boolean
}

export interface TokenInfo {
  id: string
  name: string
  permissions: AccessPermission[]
}

export type Bindings = {
  MAVEN_BUCKET: R2Bucket
  MAVEN_KV: KVNamespace
  ADMIN_BOOTSTRAP_TOKEN?: string
  SESSION_TTL_SECONDS?: string
  DEFAULT_REPOSITORY_POLICY?: string
}

export type Variables = {
  requestId: string
  token?: TokenInfo
}

export type AppEnv = {
  Bindings: Bindings
  Variables: Variables
}
