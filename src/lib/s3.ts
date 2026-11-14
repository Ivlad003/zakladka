// Minimal client for S3-compatible object storage (RustFS, MinIO, AWS S3…), talking to it straight
// from the browser. Requests are signed with AWS Signature V4 by aws4fetch.
import { AwsClient } from 'aws4fetch';

export interface S3Config {
  /** Base address of the S3 API, e.g. https://storage.example.com or http://localhost:9000. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** Optional folder inside the bucket. */
  prefix: string;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    /** S3 error code such as NoSuchBucket or SignatureDoesNotMatch; empty when the server sent none. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

const trim = (s: string) => s.trim().replace(/\/+$/, '');

export class S3Store {
  private client: AwsClient;
  private bucketUrl: string;
  private prefix: string;

  constructor(readonly config: S3Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
      service: 's3',
      region: config.region.trim() || 'us-east-1',
      retries: 2,
    });
    // Path-style addressing (endpoint/bucket/key): self-hosted servers rarely have per-bucket DNS names.
    this.bucketUrl = `${trim(config.endpoint)}/${encodeURIComponent(config.bucket.trim())}`;
    this.prefix = config.prefix.trim().replace(/^\/+|\/+$/g, '');
  }

  private url(key: string): string {
    const path = [this.prefix, key].filter(Boolean).join('/');
    return `${this.bucketUrl}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async send(url: string, init: RequestInit, okStatuses: number[] = []): Promise<Response> {
    const res = await this.client.fetch(url, init);
    if (res.ok || okStatuses.includes(res.status)) return res;
    // Errors come back as XML: <Error><Code>…</Code><Message>…</Message></Error>
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? '';
    const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? res.statusText;
    throw new S3Error(res.status, code, message || `HTTP ${res.status}`);
  }

  /** Whether the bucket exists and the credentials can reach it. */
  async bucketExists(): Promise<boolean> {
    const res = await this.send(this.bucketUrl, { method: 'HEAD' }, [404]);
    return res.status !== 404;
  }

  async createBucket(): Promise<void> {
    await this.send(this.bucketUrl, { method: 'PUT' });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const res = await this.send(this.url(key), { method: 'GET', cache: 'no-store' }, [404]);
    return res.status === 404 ? null : ((await res.json()) as T);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.send(this.url(key), { method: 'PUT', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
  }

  async getBlob(key: string): Promise<Blob | null> {
    const res = await this.send(this.url(key), { method: 'GET', cache: 'no-store' }, [404]);
    return res.status === 404 ? null : res.blob();
  }

  async putBlob(key: string, blob: Blob): Promise<void> {
    await this.send(this.url(key), { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
  }

  async delete(key: string): Promise<void> {
    await this.send(this.url(key), { method: 'DELETE' }, [404]);
  }
}

/** Turns a storage failure into a message for the reader. */
export function describeS3Error(err: unknown, config: S3Config): string {
  if (err instanceof TypeError) {
    // fetch() rejects with a TypeError when the server is unreachable or the browser blocks the request.
    const insecure = location.protocol === 'https:' && config.endpoint.trim().startsWith('http:');
    return insecure
      ? 'Браузер заблокував запит: застосунок відкрито через HTTPS, а сховище — через HTTP. Сховище теж має бути доступне через HTTPS.'
      : `Не вдалося з’єднатися зі сховищем ${trim(config.endpoint)}. Перевірте адресу і те, що сховище дозволяє запити з цього сайту (для RustFS: RUSTFS_CORS_ALLOWED_ORIGINS=${location.origin}).`;
  }
  if (err instanceof S3Error) {
    if (err.code === 'NoSuchBucket') return `Бакета «${config.bucket}» у сховищі немає.`;
    if (err.status === 403 || err.code === 'InvalidAccessKeyId' || err.code === 'SignatureDoesNotMatch') {
      return `Сховище відхилило ключі доступу (${err.code || err.status}). Перевірте Access Key, Secret Key і регіон.`;
    }
    return `Сховище повернуло помилку ${err.status}${err.code ? ` (${err.code})` : ''}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
