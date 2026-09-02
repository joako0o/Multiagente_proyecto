"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const server_1 = require("./server");
dotenv_1.default.config();
const config = {
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
    const server = new server_1.AntigravityOpenCodeServer(config);
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
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map