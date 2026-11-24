import type { z } from 'zod';
import type { OllamaToolDefinition } from '../layer1-models';
import { validateStructuredOutput } from '../layer2-prompts';
import { zodToJsonSchema } from './zod-to-json-schema';

export type McpToolClassification = 'READ_ONLY' | 'MUTATING_DRAFT';
export type McpToolScope = 'ADMIN' | 'CUSTOMER';

export interface McpToolExecutionContext {
  userId: string;
  roles: readonly string[];
  supplierId?: string;
  correlationId: string;
  jwtToken?: string;
}

export interface McpToolDefinition<
  TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  classification: McpToolClassification;
  scope: McpToolScope;
  allowedRoles: readonly string[];
  requiredPermissions: readonly string[];
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  handler: (
    input: z.output<TInputSchema>,
    context: McpToolExecutionContext,
  ) => Promise<z.output<TOutputSchema>>;
}

export interface McpToolMetadata {
  name: string;
  description: string;
  classification: McpToolClassification;
  scope: McpToolScope;
  allowedRoles: readonly string[];
  requiredPermissions: readonly string[];
  autoRunAllowed: boolean;
  requiresHumanApproval: boolean;
}

const VALID_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'READ_ONLY',
  'MUTATING_DRAFT',
]);

export class McpToolRegistry {
  private readonly tools = new Map<string, McpToolDefinition>();

  public register<
    TInputSchema extends z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny,
  >(
    definition: McpToolDefinition<TInputSchema, TOutputSchema>,
    options: { override?: boolean } = {},
  ): this {
    if (!VALID_CLASSIFICATIONS.has(definition.classification)) {
      throw new Error(
        `Invalid MCP tool classification "${String(definition.classification)}" for tool "${definition.name}". Only READ_ONLY or MUTATING_DRAFT are allowed.`,
      );
    }

    if (this.tools.has(definition.name) && !options.override) {
      throw new Error(`MCP tool "${definition.name}" is already registered.`);
    }

    this.tools.set(definition.name, definition as unknown as McpToolDefinition);
    return this;
  }

  public get(name: string): McpToolDefinition | undefined {
    return this.tools.get(name);
  }

  public getOrThrow(name: string): McpToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`MCP tool not found: ${name}`);
    }
    return tool;
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public canAutoRun(name: string): boolean {
    return this.getOrThrow(name).classification === 'READ_ONLY';
  }

  public requiresHumanApproval(name: string): boolean {
    return this.getOrThrow(name).classification === 'MUTATING_DRAFT';
  }

  public list(filter?: {
    scope?: McpToolScope;
    classification?: McpToolClassification;
  }): McpToolDefinition[] {
    return Array.from(this.tools.values()).filter((tool) => {
      if (filter?.scope && tool.scope !== filter.scope) {
        return false;
      }
      if (
        filter?.classification &&
        tool.classification !== filter.classification
      ) {
        return false;
      }
      return true;
    });
  }

  public listMetadata(filter?: {
    scope?: McpToolScope;
    classification?: McpToolClassification;
  }): McpToolMetadata[] {
    return this.list(filter).map((tool) => ({
      name: tool.name,
      description: tool.description,
      classification: tool.classification,
      scope: tool.scope,
      allowedRoles: [...tool.allowedRoles],
      requiredPermissions: [...tool.requiredPermissions],
      autoRunAllowed: tool.classification === 'READ_ONLY',
      requiresHumanApproval: tool.classification === 'MUTATING_DRAFT',
    }));
  }

  public toOllamaTools(
    audience?: McpToolScope,
    allowedTools?: readonly string[],
  ): OllamaToolDefinition[] {
    const allowSet =
      allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;

    return this.list(audience ? { scope: audience } : undefined)
      .filter((tool) => (!allowSet ? true : allowSet.has(tool.name)))
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: zodToJsonSchema(tool.inputSchema),
        },
      }));
  }

  public async execute(
    name: string,
    rawInput: unknown,
    context: McpToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.getOrThrow(name);

    const inputValidation = validateStructuredOutput(tool.inputSchema, rawInput);
    if (!inputValidation.ok) {
      const msg = inputValidation.errors
        .map((err) => `${err.path}: ${err.message}`)
        .join('; ');
      throw new Error(`Invalid input for MCP tool "${name}": ${msg}`);
    }

    const rawOutput = await tool.handler(inputValidation.data, context);

    const outputValidation = validateStructuredOutput(
      tool.outputSchema,
      rawOutput,
    );
    if (!outputValidation.ok) {
      const msg = outputValidation.errors
        .map((err) => `${err.path}: ${err.message}`)
        .join('; ');
      throw new Error(`Invalid output from MCP tool "${name}": ${msg}`);
    }

    return outputValidation.data;
  }
}
