/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/http-error.filter';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn']
  });
  app.enableCors({ origin: true });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpErrorFilter());

  // Swagger API Documentation
  const config = new DocumentBuilder()
    .setTitle('OurTextScores API')
    .setDescription(
      'API for OurTextScores - a collaborative platform for musical score transcription and version control.\n\n' +
      '## Features\n' +
      '- Work and source management with IMSLP integration\n' +
      '- File upload and derivative generation (PDF, MXL, LMX, canonical XML)\n' +
      '- Version control with Fossil VCS\n' +
      '- MusicDiff - semantic and visual diffs for musical scores\n' +
      '- Branch management for collaborative workflows\n' +
      '- Watch/subscribe for notifications\n' +
      '- User content licensing (CC licenses, Public Domain, etc.)\n\n' +
      '## Platform License\n' +
      'This API and platform are licensed under AGPL-3.0.\n\n' +
      '## User Content\n' +
      'Uploaded musical scores may be licensed separately by contributors.'
    )
    .setVersion('0.1.0')
    .setContact(
      'OurTextScores Contributors',
      'https://github.com/ourtextscores',
      ''
    )
    .setLicense('AGPL-3.0', 'https://www.gnu.org/licenses/agpl-3.0.html')
    .addTag('health', 'Health check endpoints')
    .addTag('works', 'Work and source management')
    .addTag('uploads', 'File upload operations')
    .addTag('derivatives', 'Generated file derivatives (PDF, XML, LMX)')
    .addTag('diffs', 'MusicDiff operations for comparing revisions')
    .addTag('branches', 'Branch management with Fossil VCS')
    .addTag('watches', 'Watch and notification subscriptions')
    .addTag('approvals', 'Branch merge approval workflows')
    .addTag('users', 'User management')
    .addTag('search', 'Search operations')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(4000);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap Nest application', error);
  process.exit(1);
});
