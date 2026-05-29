import type { RepositoryPolicy, ClientSettings } from '../env'
import { internalError } from '../shared'

const KV_KEY_REPOSITORY = 'config:repository'
const KV_KEY_SETTINGS = 'config:settings'

const DEFAULT_POLICY: RepositoryPolicy = {
  visibility: 'PUBLIC',
  allowReleaseRedeploy: false,
  allowSnapshotRedeploy: true,
}

const DEFAULT_SETTINGS: ClientSettings = {
  title: 'Cloud-Maven',
  baseUrl: '',
  defaultRepository: '',
  anonymousRead: true,
  allowOverwrite: false,
  generateChecksums: false,
  maintainMetadata: false,
}

export async function getRepositoryPolicy(kv: KVNamespace): Promise<RepositoryPolicy> {
  const raw = await kv.get(KV_KEY_REPOSITORY)
  if (!raw) {
    const policy = { ...DEFAULT_POLICY }
    await kv.put(KV_KEY_REPOSITORY, JSON.stringify(policy))
    return policy
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw internalError('Failed to parse repository policy')
  }
}

export async function updateRepositoryPolicy(
  kv: KVNamespace,
  patch: Partial<RepositoryPolicy>
): Promise<RepositoryPolicy> {
  const current = await getRepositoryPolicy(kv)
  const updated: RepositoryPolicy = { ...current, ...patch }
  await kv.put(KV_KEY_REPOSITORY, JSON.stringify(updated))
  return updated
}

export async function getSettings(kv: KVNamespace): Promise<ClientSettings> {
  const raw = await kv.get(KV_KEY_SETTINGS)
  if (!raw) {
    await kv.put(KV_KEY_SETTINGS, JSON.stringify(DEFAULT_SETTINGS))
    return { ...DEFAULT_SETTINGS }
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw internalError('Failed to parse settings')
  }
}

export async function updateSettings(
  kv: KVNamespace,
  patch: Partial<ClientSettings>
): Promise<ClientSettings> {
  const current = await getSettings(kv)
  const updated: ClientSettings = { ...current, ...patch }

  const policyPatch: Partial<RepositoryPolicy> = {}
  if (patch.anonymousRead !== undefined) {
    policyPatch.visibility = patch.anonymousRead ? 'PUBLIC' : 'PRIVATE'
  }
  if (patch.allowOverwrite !== undefined) {
    policyPatch.allowReleaseRedeploy = patch.allowOverwrite
  }

  await kv.put(KV_KEY_SETTINGS, JSON.stringify(updated))

  if (Object.keys(policyPatch).length > 0) {
    await updateRepositoryPolicy(kv, policyPatch)
  }

  return updated
}
