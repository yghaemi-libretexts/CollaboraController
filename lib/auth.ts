import { Request, Response, NextFunction } from 'express';
import logger from './logger';

/**
 * Optional API key/secret auth middleware.
 * When API_KEY and API_SECRET are set, requests must provide matching credentials via:
 * - Headers: X-API-Key, X-API-Secret
 * - Or Authorization: Basic base64(apiKey:apiSecret)
 */
export function apiKeyAuth(apiKey: string, apiSecret: string) {
  const expectedCredentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  return (req: Request, res: Response, next: NextFunction): void => {
    const headerKey = req.headers['x-api-key'];
    const headerSecret = req.headers['x-api-secret'];
    const authHeader = req.headers.authorization;

    let valid = false;

    if (headerKey && headerSecret) {
      valid = headerKey === apiKey && headerSecret === apiSecret;
    } else if (authHeader?.startsWith('Basic ')) {
      const provided = authHeader.slice(6).trim();
      valid = provided === expectedCredentials;
    }

    if (!valid) {
      logger.warn('Request rejected: missing or invalid API credentials');
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing API key/secret' });
      return;
    }

    next();
  };
}

/**
 * Apply auth only when both API_KEY and API_SECRET are set.
 */
export function optionalApiKeyAuth(): ((req: Request, res: Response, next: NextFunction) => void) | null {
  const apiKey = process.env.API_KEY;
  const apiSecret = process.env.API_SECRET;

  if (!apiKey || !apiSecret) {
    return null;
  }

  return apiKeyAuth(apiKey, apiSecret);
}
