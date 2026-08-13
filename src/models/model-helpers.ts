import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const UntypedSchema: any = Schema;

export const schemaOptions = {
  timestamps: true,
  optimisticConcurrency: true,
} as const;

export const objectIdField = (ref: string, required = true) => ({
  type: Schema.Types.ObjectId,
  ref,
  required,
});

export const createSchema = (
  definition: Record<string, unknown>,
  options: Record<string, unknown> = schemaOptions,
) => new UntypedSchema(definition, options);

export const registerModel = (name: string, schema: any): any =>
  (models as Record<string, unknown>)[name] ?? model(name, schema);

export { Schema };
