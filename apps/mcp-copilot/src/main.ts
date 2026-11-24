import { createLogger } from '@atelier/observability';
import { loadConfig } from './config.js';
import { createMcpCopilotServer } from './server.js';

const config = loadConfig();
const logger = createLogger(config.serviceName);
const { server, harness, close } = createMcpCopilotServer(config);

server.listen(config.port, config.host, () => {
  logger.info(
    {
      port: config.port,
      host: config.host,
      bffUrl: config.bffUrl,
      aiProvider: config.aiProvider,
      ollamaBaseUrl: config.ollamaBaseUrl,
      ollamaMainModel: harness.ollamaClient.getMainModel(),
      ollamaFastModel: harness.ollamaClient.getFastModel(),
      ollamaEmbedModel: harness.ollamaClient.getEmbedModel(),
      ollamaEmbedDim: config.ollamaEmbedDim,
      ragVectorDbConfigured: Boolean(config.ragVectorDatabaseUrl),
      registeredTools: harness.toolRegistry.list().length,
    },
    `@atelier/mcp-copilot (v3.1 Local Ollama) listening on http://${config.host}:${config.port}`,
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down @atelier/mcp-copilot');
  server.close(() => {
    void close().finally(() => {
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
