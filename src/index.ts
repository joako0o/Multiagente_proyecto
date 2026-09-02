import dotenv from 'dotenv';
import { AntigravityOpenCodeServer } from './server';
import { ServerConfig } from './types';

dotenv.config();

const config: ServerConfig = {
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || 'localhost',
  opencode: {
    url: process.env.OPENCODE_URL || 'http://localhost:4096',
    password: process.env.OPENCODE_PASSWORD,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.OPENCODE_MODEL || 'gemini-2.5-flash'
  },
  antigravity: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.ANTIGRAVITY_MODEL || 'gemini-2.5-flash'
  }
};

async function main() {
  const server = new AntigravityOpenCodeServer(config);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  });

  try {
    await server.start();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
