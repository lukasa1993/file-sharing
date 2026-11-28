// Wrangler's disposable entry. Production deploys only cloudflare/worker.ts.
import { AwsClient } from 'aws4fetch'
import {
  createCloudWorker,
  CloudWorkspace as ProductionWorkspace,
} from '../cloudflare/worker.ts'

class LocalControls {
  constructor(env, endpoint) {
    this.bucket = endpoint + '/' + env.R2_BUCKET_NAME
    this.signer = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
      retries: 0,
    })
  }
  async request(key, method, params, init = {}) {
    const url = new URL(
      this.bucket + '/' + key.split('/').map(encodeURIComponent).join('/'),
    )
    if (params) url.search = new URLSearchParams(params).toString()
    const response = await this.signer.fetch(url, { ...init, method })
    if (!response.ok && !(method === 'HEAD' && response.status === 404)) {
      const message = await response.text()
      throw new Error(
        'Local S3 control ' +
          method +
          ' returned ' +
          response.status +
          ' ' +
          (message.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? ''),
      )
    }
    return response
  }
  async createMultipartUpload(key, { httpMetadata }) {
    const response = await this.request(
      key,
      'POST',
      { uploads: '' },
      {
        headers: {
          'Content-Type': httpMetadata.contentType,
          'Content-Disposition': httpMetadata.contentDisposition,
          'Cache-Control': httpMetadata.cacheControl,
        },
      },
    )
    const id = (await response.text()).match(
      /<UploadId>([^<]+)<\/UploadId>/,
    )?.[1]
    if (!id) throw new Error('Local S3 omitted its upload ID.')
    return this.resumeMultipartUpload(key, id)
  }
  resumeMultipartUpload(key, uploadId) {
    return {
      uploadId,
      complete: async (parts) => {
        const escaped = (value) =>
          value
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
        const body =
          '<CompleteMultipartUpload>' +
          parts
            .map(
              (p) =>
                '<Part><PartNumber>' +
                p.partNumber +
                '</PartNumber><ETag>' +
                escaped(p.etag) +
                '</ETag></Part>',
            )
            .join('') +
          '</CompleteMultipartUpload>'
        const response = await this.request(
          key,
          'POST',
          { uploadId },
          { body, headers: { 'Content-Type': 'application/xml' } },
        )
        const xml = await response.text()
        if (!xml.includes('CompleteMultipartUploadResult'))
          throw new Error('Local S3 did not commit the upload.')
      },
      abort: async () => {
        const response = await this.request(key, 'DELETE', { uploadId })
        await response.body?.cancel()
      },
    }
  }
  async head(key) {
    const res = await this.request(key, 'HEAD')
    return res.ok ? { size: Number(res.headers.get('Content-Length')) } : null
  }
  async delete(key) {
    const response = await this.request(key, 'DELETE')
    await response.body?.cancel()
  }
}
export class CloudWorkspace extends ProductionWorkspace {
  constructor(ctx, env) {
    const endpoint = new URL(env.LOCAL_S3_ORIGIN)
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== '/'
    )
      throw new Error('Local S3 must be loopback.')
    super(
      ctx,
      { ...env, BUCKET: new LocalControls(env, endpoint.origin) },
      { r2Endpoint: endpoint.origin },
    )
  }
}
export default {
  fetch(request, env) {
    return createCloudWorker(env.LOCAL_S3_ORIGIN).fetch(request, env)
  },
  scheduled(event, env) {
    return createCloudWorker(env.LOCAL_S3_ORIGIN).scheduled(event, env)
  },
}
