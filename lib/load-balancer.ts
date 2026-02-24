import logger from './logger';
import type { Logger } from 'winston';
import type { Backend, LoadBalancerOptions, K8sDiscovery, DocumentAffinity } from './types';

export default class LoadBalancer {
  private k8sDiscovery: K8sDiscovery;
  private documentAffinity: DocumentAffinity;
  private strategy: 'least-connections' | 'round-robin' | 'weighted';
  private logger: Logger;
  private backends: Map<string, Backend> = new Map();
  private roundRobinIndex: number = 0;
  private connectionCounts: Map<string, number> = new Map();

  constructor(options: LoadBalancerOptions) {
    this.k8sDiscovery = options.k8sDiscovery;
    this.documentAffinity = options.documentAffinity;
    this.strategy = options.strategy || 'least-connections';
    this.logger = options.logger || logger;
  }

  async start(): Promise<void> {
    // Listen for backend updates from K8s discovery
    this.k8sDiscovery.onUpdate((backends: Backend[]) => {
      this.updateBackends(backends);
    });

    // Initial backend update
    const backends = this.k8sDiscovery.getBackends();
    this.updateBackends(backends);
  }

  private updateBackends(newBackends: Backend[]): void {
    const oldUrls = new Set(this.backends.keys());
    const newUrls = new Set(newBackends.map(b => b.url));

    // Remove backends that no longer exist
    for (const url of oldUrls) {
      if (!newUrls.has(url)) {
        this.logger.info(`Removing backend: ${url}`);
        this.backends.delete(url);
        this.connectionCounts.delete(url);
        
        // Remove document affinities for this backend
        this.documentAffinity.removeBackendAffinities(url).catch(err => {
          this.logger.error(`Error removing affinities for ${url}:`, err);
        });
      }
    }

    // Add or update backends
    for (const backend of newBackends) {
      const existing = this.backends.get(backend.url);
      if (existing) {
        // Preserve connection count
        backend.connections = existing.connections || 0;
      } else {
        backend.connections = 0;
      }
      
      this.backends.set(backend.url, backend);
      if (!this.connectionCounts.has(backend.url)) {
        this.connectionCounts.set(backend.url, 0);
      }
    }

    this.logger.debug(`Updated backends: ${this.backends.size} total`);
  }

  async selectBackend(documentId: string | null = null): Promise<Backend | null> {
    // First, try to use document affinity if document ID is provided
    if (documentId) {
      const affinityBackend = await this.documentAffinity.getAffinity(documentId);
      if (affinityBackend) {
        const backend = this.backends.get(affinityBackend);
        if (backend && backend.status === 'healthy' && !backend.draining) {
          this.logger.debug(`Using affinity backend for document ${documentId}: ${affinityBackend}`);
          return backend;
        } else {
          // Affinity backend is unhealthy or draining, remove affinity
          this.logger.warn(`Affinity backend ${affinityBackend} is unhealthy/draining, removing affinity`);
          await this.documentAffinity.removeAffinity(documentId);
        }
      }
    }

    // Get healthy, non-draining backends
    const availableBackends = Array.from(this.backends.values()).filter(
      backend => backend.status === 'healthy' && !backend.draining
    );

    if (availableBackends.length === 0) {
      this.logger.warn('No available backends');
      return null;
    }

    // Select backend based on strategy
    let selectedBackend: Backend;
    
    switch (this.strategy) {
      case 'least-connections':
        selectedBackend = this.selectLeastConnections(availableBackends);
        break;
      case 'round-robin':
        selectedBackend = this.selectRoundRobin(availableBackends);
        break;
      case 'weighted':
        selectedBackend = this.selectWeighted(availableBackends);
        break;
      default:
        selectedBackend = this.selectLeastConnections(availableBackends);
    }

    return selectedBackend;
  }

  private selectLeastConnections(backends: Backend[]): Backend {
    return backends.reduce((min, backend) => {
      const minConnections = min.connections || 0;
      const backendConnections = backend.connections || 0;
      return backendConnections < minConnections ? backend : min;
    });
  }

  private selectRoundRobin(backends: Backend[]): Backend {
    if (backends.length === 0) throw new Error('No backends available');
    const backend = backends[this.roundRobinIndex % backends.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % backends.length;
    return backend;
  }

  private selectWeighted(backends: Backend[]): Backend {
    // Weighted random selection based on backend weights
    const totalWeight = backends.reduce((sum, b) => sum + (b.weight || 100), 0);
    let random = Math.random() * totalWeight;
    
    for (const backend of backends) {
      random -= (backend.weight || 100);
      if (random <= 0) {
        return backend;
      }
    }
    
    // Fallback to first backend
    return backends[0];
  }

  incrementConnections(backendUrl: string): void {
    const backend = this.backends.get(backendUrl);
    if (backend) {
      backend.connections = (backend.connections || 0) + 1;
      this.connectionCounts.set(backendUrl, backend.connections);
    }
  }

  decrementConnections(backendUrl: string): void {
    const backend = this.backends.get(backendUrl);
    if (backend) {
      backend.connections = Math.max(0, (backend.connections || 0) - 1);
      this.connectionCounts.set(backendUrl, backend.connections);
    }
  }

  markBackendUnhealthy(backendUrl: string): void {
    const backend = this.backends.get(backendUrl);
    if (backend) {
      backend.status = 'unhealthy';
      this.logger.warn(`Marked backend as unhealthy: ${backendUrl}`);
    }
  }

  markBackendHealthy(backendUrl: string): void {
    const backend = this.backends.get(backendUrl);
    if (backend) {
      backend.status = 'healthy';
      this.logger.info(`Marked backend as healthy: ${backendUrl}`);
    }
  }

  async getBackends(): Promise<Backend[]> {
    return Array.from(this.backends.values());
  }

  // Graceful drain: mark backend as draining and wait for connections to drain
  async drainBackend(backendUrl: string, timeout: number = 300000): Promise<boolean> {
    const backend = this.backends.get(backendUrl);
    if (!backend) {
      throw new Error(`Backend not found: ${backendUrl}`);
    }

    backend.draining = true;
    backend.status = 'draining';
    this.logger.info(`Started draining backend: ${backendUrl}`);

    // Wait for connections to drain
    const startTime = Date.now();
    while (backend.connections > 0 && (Date.now() - startTime) < timeout) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.logger.debug(`Waiting for connections to drain on ${backendUrl}: ${backend.connections} remaining`);
    }

    if (backend.connections > 0) {
      this.logger.warn(`Timeout waiting for connections to drain on ${backendUrl}: ${backend.connections} remaining`);
    } else {
      this.logger.info(`Successfully drained backend: ${backendUrl}`);
    }

    return backend.connections === 0;
  }
}
