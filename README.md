# Collabora Online Controller for Kubernetes

A smart load balancer controller for Collabora Online that provides WOPI document affinity and intelligent pod load balancing in Kubernetes environments.

## Features

- **WOPI Document Affinity**: Maintains sticky sessions based on document IDs extracted from WOPI requests
- **Kubernetes Pod Discovery**: Automatically discovers Collabora Online pods from Kubernetes
- **Multiple Load Balancing Strategies**: Supports least-connections, round-robin, and weighted algorithms
- **Graceful Drain Support**: Handles pod shutdowns gracefully by draining connections
- **Redis-backed Affinity**: Uses Redis for distributed document-to-backend affinity tracking
- **Health Monitoring**: Tracks backend health and automatically removes unhealthy pods
- **Weighted Backends**: Supports weighted backend selection via pod annotations

## Architecture

```
┌─────────────────┐
│   WOPI Client   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│  Collabora Controller   │
│  (Express.js Server)    │
└────────┬────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌──────────────┐
│ Redis  │ │ Kubernetes   │
│        │ │ API Server   │
└────────┘ └──────┬───────┘
                  │
                  ▼
         ┌────────────────┐
         │ Collabora Pods │
         │  (Backends)    │
         └────────────────┘
```

## How It Works

1. **Document ID Extraction**: The controller extracts document IDs from WOPI requests (path, query params, or headers)
2. **Affinity Lookup**: Checks Redis for existing document-to-backend affinity
3. **Backend Selection**: 
   - If affinity exists and backend is healthy → uses affinity backend
   - Otherwise → selects backend using configured load balancing strategy
4. **Affinity Storage**: Stores document-to-backend mapping in Redis for future requests
5. **Pod Discovery**: Continuously monitors Kubernetes for Collabora pod changes
6. **Connection Tracking**: Tracks active connections per backend for least-connections algorithm

## Installation

### Prerequisites

- Kubernetes cluster (1.19+)
- Node.js 18+ (for local development)
- Redis (can be deployed via included manifests)

### Deploy Redis

```bash
kubectl apply -f k8s/redis-deployment.yaml
```

### Deploy Collabora Controller

1. Build the Docker image:
```bash
docker build -t collabora-controller:latest .
```

2. Update the `k8s/deployment.yaml` with your image registry if needed

3. Deploy:
```bash
kubectl apply -f k8s/deployment.yaml
```

### Configuration

The controller can be configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `COLLABORA_SERVICE` | `collabora` | Kubernetes service name for Collabora pods |
| `COLLABORA_NAMESPACE` | `default` | Kubernetes namespace |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | `` | Redis password (optional) |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |

## Usage

### Basic Setup

The controller automatically proxies all requests to Collabora pods. Point your WOPI clients to the controller service:

```
http://collabora-controller-service/wopi/files/{file_id}/contents
```

### Weighted Backends

To assign weights to specific Collabora pods, add an annotation:

```yaml
metadata:
  annotations:
    collabora-controller/weight: "150"  # Higher weight = more traffic
```

### Graceful Drain

To gracefully drain a pod before shutdown, add a draining annotation:

```yaml
metadata:
  annotations:
    collabora-controller/draining: "true"
```

The controller will:
1. Stop routing new requests to the draining pod
2. Wait for existing connections to complete
3. Remove document affinities for that backend

### Load Balancing Strategies

The default strategy is `least-connections`. To change it, modify the `LoadBalancer` initialization in `server.js`:

```javascript
const loadBalancer = new LoadBalancer({
  k8sDiscovery,
  documentAffinity,
  strategy: 'least-connections', // or 'round-robin' or 'weighted'
  logger
});
```

## API Endpoints

### Health Check
```
GET /health
```
Returns controller health status.

### Metrics
```
GET /metrics
```
Returns load balancer metrics including:
- Total backends
- Active backends
- Per-backend connection counts
- Backend weights and status

## WOPI Document ID Extraction

The controller extracts document IDs from multiple sources (in order of priority):

1. **Path**: `/wopi/files/{file_id}/...`
2. **Query Parameter**: `?file_id={file_id}`
3. **Header**: `X-WOPI-Document-ID`

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5+
- Kubernetes cluster access (for pod discovery)
- Redis (local or Kubernetes deployment)

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables (create `.env` file):
```
PORT=3000
COLLABORA_SERVICE=collabora
COLLABORA_NAMESPACE=default
REDIS_HOST=localhost
REDIS_PORT=6379
LOG_LEVEL=debug
```

3. Ensure you have `kubectl` configured and access to your cluster

4. Start Redis locally or use the Kubernetes deployment

5. Build TypeScript:
```bash
npm run build
```

6. Run the server:
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### TypeScript

The project is written in TypeScript. To check types:
```bash
npm run type-check
```

### Testing

The project includes comprehensive unit tests using Jest and TypeScript.

**Run all tests:**
```bash
npm test
```

**Run tests in watch mode:**
```bash
npm run test:watch
```

**Run tests with coverage:**
```bash
npm run test:coverage
```

**Test Structure:**
- `__tests__/lib/` - Unit tests for library modules
  - `logger.test.ts` - Logger tests
  - `document-affinity.test.ts` - Redis affinity tests
  - `k8s-discovery.test.ts` - Kubernetes discovery tests
  - `load-balancer.test.ts` - Load balancer tests
- `__tests__/server.test.ts` - Server integration tests

**Test Coverage:**
- Document affinity management
- Load balancing strategies (least-connections, round-robin, weighted)
- Kubernetes pod discovery
- Connection tracking
- Backend health management
- Graceful drain functionality
- WOPI document ID extraction

### Testing

Test the health endpoint:
```bash
curl http://localhost:3000/health
```

Test metrics:
```bash
curl http://localhost:3000/metrics
```

## Monitoring

The controller logs important events:
- Pod discovery and removal
- Document affinity assignments
- Backend health changes
- Connection tracking

Monitor logs:
```bash
kubectl logs -f deployment/collabora-controller
```

## Troubleshooting

### No Backends Available

- Check that Collabora pods are running and ready
- Verify the `COLLABORA_SERVICE` label matches your pod labels
- Check controller logs for discovery errors

### Redis Connection Issues

- Verify Redis is accessible from controller pods
- Check Redis service name and port
- Review Redis connection logs

### Document Affinity Not Working

- Verify Redis is running and accessible
- Check that document IDs are being extracted correctly (enable debug logging)
- Review Redis key expiration settings (default: 1 hour)

## License

MIT
