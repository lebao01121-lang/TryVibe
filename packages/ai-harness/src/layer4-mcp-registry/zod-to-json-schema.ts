import { z } from 'zod';

type ZodDefAny = {
  typeName?: string;
  description?: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  defaultValue?: () => unknown;
  shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>;
  values?: readonly string[] | Record<string, string | number>;
  value?: unknown;
  type?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  options?: readonly z.ZodTypeAny[];
  checks?: ReadonlyArray<{
    kind?: string;
    value?: number;
    inclusive?: boolean;
  }>;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
};

function getDef(schema: z.ZodTypeAny): ZodDefAny {
  return (schema as unknown as { _def: ZodDefAny })._def ?? {};
}

function isOptionalLike(schema: z.ZodTypeAny): boolean {
  const def = getDef(schema);
  if (
    def.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
    def.typeName === z.ZodFirstPartyTypeKind.ZodDefault
  ) {
    return true;
  }
  if (def.typeName === z.ZodFirstPartyTypeKind.ZodEffects && def.schema) {
    return isOptionalLike(def.schema);
  }
  return false;
}

/**
 * Converts a Zod v3 schema into standard JSON Schema (Draft 7 / Ollama tool parameters)
 * without requiring an external npm dependency.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = getDef(schema);
  const typeName = def.typeName;
  const description = def.description;

  const withDesc = (obj: Record<string, unknown>): Record<string, unknown> =>
    description && obj.description === undefined ? { ...obj, description } : obj;

  if (typeName === z.ZodFirstPartyTypeKind.ZodOptional && def.innerType) {
    return withDesc(zodToJsonSchema(def.innerType));
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodDefault && def.innerType) {
    const inner = zodToJsonSchema(def.innerType);
    const defaultVal =
      typeof def.defaultValue === 'function' ? def.defaultValue() : undefined;
    return withDesc({
      ...inner,
      ...(defaultVal !== undefined ? { default: defaultVal } : {}),
    });
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodNullable && def.innerType) {
    const inner = zodToJsonSchema(def.innerType);
    if (typeof inner.type === 'string') {
      return withDesc({ ...inner, type: [inner.type, 'null'] });
    }
    return withDesc({ anyOf: [inner, { type: 'null' }] });
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodEffects && def.schema) {
    return withDesc(zodToJsonSchema(def.schema));
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodString) {
    const out: Record<string, unknown> = { type: 'string' };
    for (const check of def.checks ?? []) {
      if (check.kind === 'min' && typeof check.value === 'number') {
        out.minLength = check.value;
      } else if (check.kind === 'max' && typeof check.value === 'number') {
        out.maxLength = check.value;
      } else if (check.kind === 'email') {
        out.format = 'email';
      } else if (check.kind === 'datetime') {
        out.format = 'date-time';
      } else if (check.kind === 'url') {
        out.format = 'uri';
      }
    }
    return withDesc(out);
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodNumber) {
    let isInt = false;
    const out: Record<string, unknown> = { type: 'number' };
    for (const check of def.checks ?? []) {
      if (check.kind === 'int') {
        isInt = true;
      } else if (check.kind === 'min' && typeof check.value === 'number') {
        out.minimum = check.value;
      } else if (check.kind === 'max' && typeof check.value === 'number') {
        out.maximum = check.value;
      }
    }
    if (isInt) {
      out.type = 'integer';
    }
    return withDesc(out);
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodBoolean) {
    return withDesc({ type: 'boolean' });
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodEnum && Array.isArray(def.values)) {
    return withDesc({
      type: 'string',
      enum: [...def.values],
    });
  }

  if (
    typeName === z.ZodFirstPartyTypeKind.ZodNativeEnum &&
    def.values &&
    !Array.isArray(def.values)
  ) {
    const vals = Object.values(def.values);
    return withDesc({
      type: typeof vals[0] === 'number' ? 'number' : 'string',
      enum: vals,
    });
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodLiteral) {
    return withDesc({
      const: def.value,
      enum: [def.value],
    });
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodArray && def.type) {
    const out: Record<string, unknown> = {
      type: 'array',
      items: zodToJsonSchema(def.type),
    };
    if (def.minLength && typeof def.minLength.value === 'number') {
      out.minItems = def.minLength.value;
    }
    if (def.maxLength && typeof def.maxLength.value === 'number') {
      out.maxItems = def.maxLength.value;
    }
    return withDesc(out);
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    const rawShape =
      typeof def.shape === 'function' ? def.shape() : (def.shape ?? {});
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(rawShape)) {
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!isOptionalLike(fieldSchema)) {
        required.push(key);
      }
    }

    return withDesc({
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    });
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodRecord) {
    return withDesc({
      type: 'object',
      additionalProperties: def.valueType ? zodToJsonSchema(def.valueType) : true,
    });
  }

  if (typeName === z.ZodFirstPartyTypeKind.ZodUnion && Array.isArray(def.options)) {
    return withDesc({
      anyOf: def.options.map((opt) => zodToJsonSchema(opt)),
    });
  }

  return withDesc({});
}
