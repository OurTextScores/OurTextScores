import { Client } from 'minio';
import { Readable } from 'node:stream';

export interface StorageConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  rawBucket?: string;
  derivativesBucket?: string;
  auxBucket?: string;
}

export interface PutObjectResult {
  bucket: string;
  objectKey: string;
  etag: string;
  versionId?: string;
}

export class StorageService {
  private readonly client: Client;
  private readonly rawBucket: string;
  private readonly derivativesBucket: string;
  private readonly auxBucket: string;

  constructor(config: StorageConfig) {
    this.client = new Client({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey
    });

    this.rawBucket = config.rawBucket ?? 'scores-raw';
    this.derivativesBucket = config.derivativesBucket ?? 'scores-derivatives';
    this.auxBucket = config.auxBucket ?? 'scores-aux';
  }

  async ensureBucket(bucket: string): Promise<void> {
    const exists = await this.client.bucketExists(bucket);
    if (!exists) {
      await this.client.makeBucket(bucket, '');
    }
  }

  async putRawObject(
    objectKey: string,
    body: Buffer | Readable,
    size: number,
    contentType: string
  ): Promise<PutObjectResult> {
    await this.ensureBucket(this.rawBucket);
    const response = await this.client.putObject(
      this.rawBucket,
      objectKey,
      body,
      size,
      {
        'Content-Type': contentType
      }
    );

    return {
      bucket: this.rawBucket,
      objectKey,
      etag: response.etag,
      versionId: response.versionId
    };
  }

  async putDerivativeObject(
    objectKey: string,
    body: Buffer | Readable,
    size: number,
    contentType: string
  ): Promise<PutObjectResult> {
    await this.ensureBucket(this.derivativesBucket);
    const response = await this.client.putObject(
      this.derivativesBucket,
      objectKey,
      body,
      size,
      {
        'Content-Type': contentType
      }
    );

    return {
      bucket: this.derivativesBucket,
      objectKey,
      etag: response.etag,
      versionId: response.versionId
    };
  }

  async putAuxiliaryObject(
    objectKey: string,
    body: Buffer | Readable,
    size: number,
    contentType: string
  ): Promise<PutObjectResult> {
    await this.ensureBucket(this.auxBucket);
    const response = await this.client.putObject(
      this.auxBucket,
      objectKey,
      body,
      size,
      {
        'Content-Type': contentType
      }
    );

    return {
      bucket: this.auxBucket,
      objectKey,
      etag: response.etag,
      versionId: response.versionId
    };
  }

  async getObjectBuffer(bucket: string, objectKey: string): Promise<Buffer> {
    const stream = await this.client.getObject(bucket, objectKey);
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk as Buffer));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }

  async getAuxObjectBuffer(objectKey: string): Promise<Buffer> {
    await this.ensureBucket(this.auxBucket);
    return this.getObjectBuffer(this.auxBucket, objectKey);
  }

  async statAuxObject(objectKey: string): Promise<boolean> {
    await this.ensureBucket(this.auxBucket);
    try {
      await this.client.statObject(this.auxBucket, objectKey);
      return true;
    } catch {
      return false;
    }
  }

  async deleteObject(bucket: string, objectKey: string): Promise<void> {
    try {
      await this.client.removeObject(bucket, objectKey);
    } catch (err) {
      // ignore missing objects
    }
  }
}
