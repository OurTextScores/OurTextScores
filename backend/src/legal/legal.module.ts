import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { LegalController } from './legal.controller';
import { LegalService } from './legal.service';
import { TakedownCase, TakedownCaseSchema } from './schemas/takedown-case.schema';
import { TakedownNotice, TakedownNoticeSchema } from './schemas/takedown-notice.schema';
import { CounterNotice, CounterNoticeSchema } from './schemas/counter-notice.schema';
import { EnforcementAction, EnforcementActionSchema } from './schemas/enforcement-action.schema';
import { Source, SourceSchema } from '../works/schemas/source.schema';
import { SourceRevision, SourceRevisionSchema } from '../works/schemas/source-revision.schema';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: TakedownCase.name, schema: TakedownCaseSchema },
      { name: TakedownNotice.name, schema: TakedownNoticeSchema },
      { name: CounterNotice.name, schema: CounterNoticeSchema },
      { name: EnforcementAction.name, schema: EnforcementActionSchema },
      { name: Source.name, schema: SourceSchema },
      { name: SourceRevision.name, schema: SourceRevisionSchema }
    ])
  ],
  controllers: [LegalController],
  providers: [LegalService],
  exports: [LegalService]
})
export class LegalModule {}
