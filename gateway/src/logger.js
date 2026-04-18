'use strict';

/**
 * OpenClaw Gateway — Logger
 * Centralised Winston logger used across all modules.
 */

const path = require('path');
const { createLogger, format, transports } = require('winston');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '..', 'logs', 'gateway.log');

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

const fileFormat = format.combine(
  format.timestamp(),
  format.json()
);

const logger = createLogger({
  level: LOG_LEVEL,
  transports: [
    new transports.Console({ format: consoleFormat }),
    new transports.File({
      filename: LOG_FILE,
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
  exceptionHandlers: [
    new transports.Console({ format: consoleFormat }),
    new transports.File({ filename: LOG_FILE, format: fileFormat }),
  ],
  rejectionHandlers: [
    new transports.Console({ format: consoleFormat }),
    new transports.File({ filename: LOG_FILE, format: fileFormat }),
  ],
});

module.exports = logger;
