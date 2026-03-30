// src/utils/logger.js
import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

let logger;

if (!isProd) {
  // Try to use pino-pretty for pretty console output during development.
  // If pino-pretty is not installed the code falls back to plain pino.
  try {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    });
    logger = pino({ level: logLevel }, transport);
  } catch (err) {
    // fallback
    logger = pino({ level: logLevel });
  }
} else {
  // production: structured JSON logs only
  logger = pino({ level: logLevel });
}

export default logger;
