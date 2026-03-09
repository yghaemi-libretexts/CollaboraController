import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '.env') });
if (!process.env.PORT) dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import K8sDiscovery from './lib/k8s-discovery';
import DocumentAffinity from './lib/document-affinity';
import LoadBalancer from './lib/load-balancer';
import logger from './lib/logger';
import { optionalApiKeyAuth } from './lib/auth';


// Ensure AWS_REGION is set when using AWS credentials (e.g. for EKS get-token)
if (process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_REGION) {
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const COLLABORA_SERVICE = process.env.COLLABORA_SERVICE || 'collabora';
const COLLABORA_NAMESPACE = process.env.COLLABORA_NAMESPACE || 'default';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';

// Initialize services
const k8sDiscovery = new K8sDiscovery({
  namespace: COLLABORA_NAMESPACE,
  serviceName: COLLABORA_SERVICE,
  logger
});

const documentAffinity = new DocumentAffinity({
  redisHost: REDIS_HOST,
  redisPort: REDIS_PORT,
  redisPassword: REDIS_PASSWORD,
  logger
});

const loadBalancer = new LoadBalancer({
  k8sDiscovery,
  documentAffinity,
  strategy: 'least-connections',
  logger
});

// Require a Bearer token on every request (except health/metrics)
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health' || req.path === '/metrics') return next();

  // const authHeader = req.headers.authorization;
  // if (!authHeader || !authHeader.startsWith('Bearer ')) {
  //   return res.status(401).json({ error: 'Missing Bearer token' });
  // }

  next();
});

// Optional API key/secret auth for proxy (skip for health and metrics)
const requireAuth = optionalApiKeyAuth();
if (requireAuth) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health' || req.path === '/metrics') return next();
    requireAuth(req, res, next);
  });
  logger.info('API key/secret authentication enabled');
}

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Metrics endpoint
app.get('/metrics', async (req: Request, res: Response) => {
  try {
    const backends = await loadBalancer.getBackends();
    const metrics = {
      totalBackends: backends.length,
      activeBackends: backends.filter(b => b.status === 'healthy').length,
      backends: backends.map(b => ({
        url: b.url,
        status: b.status,
        connections: b.connections,
        weight: b.weight,

      }))
    };
    res.json(metrics);
  } catch (error) {
    logger.error('Error fetching metrics:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// Extract document ID from WOPI request
function extractDocumentId(req: http.IncomingMessage): string | null {
  const url = (req as any).originalUrl || req.url || '';

  const wopiMatch = url.match(/\/wopi\/files\/([^\/]+)/);
  if (wopiMatch) {
    return wopiMatch[1];
  }

  const query = (req as any).query;
  if (query?.file_id && typeof query.file_id === 'string') {
    return query.file_id;
  }

  const docIdHeader = req.headers['x-wopi-document-id'];
  if (docIdHeader && typeof docIdHeader === 'string') {
    return docIdHeader;
  }

  return null;
}

// Single proxy middleware with dynamic routing via `router`
const proxy = createProxyMiddleware({
  // target: 'http://localhost:9980',
  router: async (req) => {
    const documentId = extractDocumentId(req);
    const backend = await loadBalancer.selectBackend(documentId);
    // const backend = {
    //   url: 'http://localhost:9980',
    //   connections: 0,
    //   status: 'healthy',
    //   weight: 100,
    //   draining: false,
    //   lastSeen: new Date(),
    //   podName: 'localhost',
    //   serviceIP: '127.0.0.1',
    // }
    
    if (!backend) throw new Error('No available backends');
    (req as any)._backend = backend;
    (req as any)._documentId = documentId;
    return backend.url;
  },
  changeOrigin: false,
  ws: true,
  timeout: 0,
  proxyTimeout: 0,
  on: {
    proxyReq: (proxyReq, req) => {
      const backend = (req as any)._backend;
      const documentId = (req as any)._documentId as string | null;
      if (!backend) return;

      const host = req.headers.host || '';
      const clientIp = (req as any).socket?.remoteAddress || '';
      const existing = req.headers['x-forwarded-for'];
      const forwarded = existing ? `${existing}, ${clientIp}` : clientIp;

      proxyReq.setHeader('X-Forwarded-Host', host);
      proxyReq.setHeader('X-Forwarded-Proto', 'https');
      proxyReq.setHeader('X-Forwarded-For', forwarded);

      loadBalancer.incrementConnections(backend.url);

      if (documentId) {
        documentAffinity.setAffinity(documentId, backend.url).catch(err => {
          logger.error('Failed to set document affinity:', err);
        });
        proxyReq.setHeader('X-WOPI-Document-ID', documentId);
      }

      logger.debug('Proxy request', {
        method: proxyReq.method,
        target: `${backend.url}${proxyReq.path}`,
        headers: proxyReq.getHeaders(),
      });
    },
    proxyRes: (_proxyRes, req) => {
      const backend = (req as any)._backend;
      const documentId = (req as any)._documentId as string | null;
      if (documentId && backend) {
        documentAffinity.setAffinity(documentId, backend.url).catch(err => {
          logger.debug('Failed to set document affinity:', err);
        });
      }
      if (backend) {
        _proxyRes.on('end', () => {
          loadBalancer.decrementConnections(backend.url);
        });
      }
    },
    error: (err, req, res) => {
      const backend = (req as any)._backend;
      logger.error(`Proxy error for ${backend?.url ?? 'unknown'}:`, err);

      if (backend) {
        loadBalancer.markBackendUnhealthy(backend.url);
      }

      if ('headersSent' in res && !res.headersSent) {
        (res as Response).status(502).json({ error: 'Backend unavailable' });
      }
    },
    close: (_req, socket) => {
      const backend = (socket as any)._backend;
      if (backend) loadBalancer.decrementConnections(backend.url);
    }
  }
});

app.use(proxy);

// Initialize services and start server
async function start(): Promise<void> {
  try {
    // Initialize Redis connection
    await documentAffinity.initialize();
    logger.info('Document affinity service initialized');
    
    // Start Kubernetes discovery
    await k8sDiscovery.start();
    logger.info('Kubernetes discovery started');
    
    // Start load balancer
    await loadBalancer.start();
    logger.info('Load balancer started');
    
    // Start Express server and wire up WebSocket upgrades
    const server = http.createServer(app);
    server.on('upgrade', proxy.upgrade!);
    server.listen(PORT, () => {
      logger.info(`Collabora Controller listening on port ${PORT}`);
      logger.info(`Targeting Collabora service: ${COLLABORA_SERVICE} in namespace: ${COLLABORA_NAMESPACE}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await k8sDiscovery.stop();
  await documentAffinity.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await k8sDiscovery.stop();
  await documentAffinity.close();
  process.exit(0);
});

start();
