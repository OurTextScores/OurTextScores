import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class ValidationIssue {
  @Prop({ required: true, trim: true })
  level!: string;

  @Prop({ required: true, trim: true })
  code!: string;

  @Prop({ required: true })
  message!: string;

  @Prop({ trim: true })
  path?: string;
}

export const ValidationIssueSchema = SchemaFactory.createForClass(ValidationIssue);

@Schema({ _id: false })
export class ValidationState {
  @Prop({ required: true, enum: ['pending', 'passed', 'failed'], default: 'pending' })
  status!: 'pending' | 'passed' | 'failed';

  @Prop({ type: Date })
  performedAt?: Date;

  @Prop({ trim: true })
  validatorVersion?: string;

  @Prop({ type: [ValidationIssueSchema], default: [] })
  issues!: ValidationIssue[];

  @Prop({ trim: true })
  overrideNote?: string;
}

export const ValidationStateSchema = SchemaFactory.createForClass(ValidationState);
