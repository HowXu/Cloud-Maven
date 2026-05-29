import type { R2Object, R2ObjectBody, R2Objects } from '@cloudflare/workers-types'

export async function getObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key)
}

export async function headObject(bucket: R2Bucket, key: string): Promise<R2Object | null> {
  return bucket.head(key)
}

export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream | ArrayBuffer | string,
  options?: R2PutOptions
): Promise<R2Object> {
  return bucket.put(key, body, options)
}

export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key)
}

export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let truncated = true
  let cursor: string | undefined

  while (truncated) {
    const result = await bucket.list({ prefix, cursor })
    truncated = result.truncated
    cursor = result.cursor

    const promises: Promise<void>[] = []
    for (const obj of result.objects) {
      promises.push(bucket.delete(obj.key))
    }
    await Promise.all(promises)
  }
}

export async function listObjects(
  bucket: R2Bucket,
  prefix: string,
  delimiter?: string,
  limit = 200
): Promise<R2Objects> {
  return bucket.list({ prefix, delimiter, limit })
}
