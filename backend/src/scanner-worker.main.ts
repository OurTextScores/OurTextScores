import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { NestFactory } from '@nestjs/core';
import { ScannerModule } from './scanner/scanner.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI', 'mongodb://localhost:27017/ourtextscores'),
        autoIndex: config.get<string>('MONGO_AUTO_INDEX', 'false') === 'true'
      })
    }),
    ScannerModule
  ]
})
class ScannerWorkerAppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ScannerWorkerAppModule, {
    logger: ['log', 'error', 'warn']
  });
  app.enableShutdownHooks();
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap Scanner worker', error);
  process.exit(1);
});
