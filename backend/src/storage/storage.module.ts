import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: StorageService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
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
          } catch (err) {
            // ignore malformed URL and fall back to explicit env vars
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
    }
  ],
  exports: [StorageService]
})
export class StorageModule {}
