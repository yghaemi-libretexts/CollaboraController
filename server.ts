import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '.env') });
if (!process.env.PORT) dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
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

// Middleware to parse JSON
app.use(express.json());

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
function extractDocumentId(req: Request): string | null {
  // WOPI requests typically have document IDs in the path
  // Format: /wopi/files/{file_id}/contents or /wopi/files/{file_id}
  const wopiMatch = req.originalUrl.match(/\/wopi\/files\/([^\/]+)/);
  if (wopiMatch) {
    return wopiMatch[1];
  }
  
  // Also check query parameters
  if (req.query.file_id && typeof req.query.file_id === 'string') {
    return req.query.file_id;
  }
  
  // Check for document ID in headers
  const docIdHeader = req.headers['x-wopi-document-id'];
  if (docIdHeader && typeof docIdHeader === 'string') {
    return docIdHeader;
  }
  
  return null;
}

// Main proxy middleware with WOPI document affinity
app.use('*', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const documentId = extractDocumentId(req);
    // Get the target backend using load balancer
    const backend = await loadBalancer.selectBackend(documentId);
    if (!backend) {
      logger.warn('No available backends');
      return res.status(503).json({ error: 'No available backends' });
    }
    
    logger.debug(`Routing request to ${backend.url} for document ${documentId || 'none'}`);
    
    // Create proxy middleware for this specific backend
    const proxyOptions: Options = {
      target: backend.url,
      changeOrigin: true,
      ws: true, // WebSocket support for Collabora
      onProxyReq: (proxyReq, req, res) => {
        // Track connection
        loadBalancer.incrementConnections(backend.url);
        
        // Add document ID to headers for tracking
        if (documentId) {
          documentAffinity.setAffinity(documentId, backend.url).catch(err => {
            logger.error('Failed to set document affinity:', err);
          });
          proxyReq.setHeader('X-WOPI-Document-ID', documentId);
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        // Store document affinity if document ID exists
        if (documentId) {
          documentAffinity.setAffinity(documentId, backend.url).catch(err => {
            logger.error('Failed to set document affinity:', err);
          });
        }
      },
      onError: (err, req, res) => {
        logger.error(`Proxy error for ${backend.url}:`, err);
        loadBalancer.markBackendUnhealthy(backend.url);
        
        // Try to find another backend
        loadBalancer.selectBackend(documentId)
          .then(altBackend => {
            if (altBackend) {
              logger.info(`Retrying with alternative backend: ${altBackend.url}`);
              // Retry logic could be implemented here
            }
          });
        
        if (!res.headersSent) {
          (res as Response).status(502).json({ error: 'Backend unavailable' });
        }
      },
      onClose: (req, socket, head) => {
        // Decrement connection count when connection closes
        loadBalancer.decrementConnections(backend.url);
      }
    };
    
    const proxy = createProxyMiddleware(proxyOptions);
    proxy(req, res, next);
  } catch (error) {
    logger.error('Error in proxy middleware:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

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
    
    // Start Express server
    app.listen(PORT, () => {
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
