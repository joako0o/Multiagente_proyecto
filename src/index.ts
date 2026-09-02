/**
 * Punto de entrada. Carga `.env`, construye la configuración y arranca el servidor.
 */
import dotenv from 'dotenv';
import { loadConfig } from './config';
import { BridgeServer } from './server';

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new BridgeServer(config);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} recibido, cerrando...`);
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.start();
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
