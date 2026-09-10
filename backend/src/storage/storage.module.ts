import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

const logger = new Logger('StorageModule');

export function storageServiceFromConfig(config: ConfigService): StorageService {
  const url = config.get<string>('MINIO_URL');
  let endPoint = config.get<string>('MINIO_ENDPOINT', 'localhost');
  let port = parseInt(config.get<string>('MINIO_PORT', '9000'), 10);
  let useSSL = config.get<string>('MINIO_USE_SSL', 'false') === 'true';

  if (url) {
    try {
      const parsed = new URL(url);
      endPoint = parsed.hostname;
      port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
      useSSL = parsed.protocol === 'https:';
    } catch {
      logger.warn('MINIO_URL is invalid; using MINIO_ENDPOINT and MINIO_PORT instead');
    }
  }

  return new StorageService({
    endPoint,
    port,
    useSSL,
    accessKey: config.get<string>('MINIO_ACCESS_KEY', ''),
    secretKey: config.get<string>('MINIO_SECRET_KEY', ''),
    rawBucket: config.get<string>('MINIO_RAW_BUCKET', 'scores-raw'),
    derivativesBucket: config.get<string>('MINIO_DERIVATIVES_BUCKET', 'scores-derivatives'),
    auxBucket: config.get<string>('MINIO_AUX_BUCKET', 'scores-aux')
  });
}

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: StorageService,
      inject: [ConfigService],
      useFactory: storageServiceFromConfig
    }
  ],
  exports: [StorageService]
})
export class StorageModule {}
