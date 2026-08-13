import 'dotenv/config';
import { Application } from './application';
import { loadConfig } from './config';
import { Logger } from './logger';

async function main(): Promise<void> {
  const application = new Application(loadConfig());
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    await application.stop();
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  await application.start();
}

void main().catch((error: unknown) => {
  new Logger('MAIN', 'error').error('Application startup failed', { cause: error });
  process.exitCode = 1;
});
