import type { z } from 'zod';

export interface StructuredOutputValidationError {
  path: string;
  message: string;
}

export type StructuredOutputResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      errors: StructuredOutputValidationError[];
      rawPreview: string;
    };

function stripJsonCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

export function validateStructuredOutput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  raw: unknown,
): StructuredOutputResult<z.output<TSchema>> {
  let candidate: unknown = raw;

  if (typeof raw === 'string') {
    const cleaned = stripJsonCodeFence(raw);
    try {
      candidate = JSON.parse(cleaned);
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            path: '$',
            message: `Invalid JSON output: ${error instanceof Error ? error.message : 'parse error'}`,
          },
        ],
        rawPreview: cleaned.slice(0, 200),
      };
    }
  }

  const parsed = schema.safeParse(candidate);
  if (parsed.success) {
    return {
      ok: true,
      data: parsed.data as z.output<TSchema>,
    };
  }

  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '$',
      message: issue.message,
    })),
    rawPreview:
      typeof raw === 'string'
        ? raw.slice(0, 200)
        : JSON.stringify(raw ?? null).slice(0, 200),
  };
}

export function parseStructuredOutputOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  raw: unknown,
): z.output<TSchema> {
  const result = validateStructuredOutput(schema, raw);
  if (!result.ok) {
    const details = result.errors
      .map((err) => `${err.path}: ${err.message}`)
      .join('; ');
    throw new Error(`Structured output validation failed: ${details}`);
  }
  return result.data;
}
