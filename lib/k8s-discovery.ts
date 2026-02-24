import * as k8s from '@kubernetes/client-node';
import logger from './logger';
import type { Logger } from 'winston';
import type { Backend, K8sDiscoveryOptions } from './types';

export default class K8sDiscovery {
  private namespace: string;
  private serviceName: string;
  private logger: Logger;
  private k8sApi: k8s.CoreV1Api | null = null;
  private watch: k8s.Watch | null = null;
  private backends: Map<string, Backend> = new Map();
  private updateCallback: ((backends: Backend[]) => void) | null = null;
  private discoveryInterval: NodeJS.Timeout | null = null;

  constructor(options: K8sDiscoveryOptions = {}) {
    this.namespace = options.namespace || 'default';
    this.serviceName = options.serviceName || 'collabora';
    this.logger = options.logger || logger;
  }

  async initialize(): Promise<void> {
    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      
      this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      this.logger.info('Kubernetes client initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Kubernetes client:', error);
      throw error;
    }
  }

  async discoverPods(): Promise<Backend[]> {
    if (!this.k8sApi) {
      await this.initialize();
    }

    try {
      // Get pods for the service
      const response = await this.k8sApi!.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `app=${this.serviceName}`
      });

      const pods = response.items || [];
      const newBackends = new Map<string, Backend>();

      for (const pod of pods) {
        const podName = pod.metadata?.name || '';
        const podIP = pod.status?.podIP;
        const phase = pod.status?.phase;
        const ready = pod.status?.conditions?.find((c: k8s.V1PodCondition) => c.type === 'Ready')?.status === 'True';

        // Only include running and ready pods
        if (phase === 'Running' && ready && podIP) {
          // Get pod port from service or use default
          const port = this.getPodPort(pod) || 9980;
          const url = `http://${podIP}:${port}`;
          
          // Get weight from pod annotations or use default
          const weight = parseInt(pod.metadata?.annotations?.['collabora-controller/weight'] || '100', 10);
          
          // Check if pod is draining
          const draining = pod.metadata?.annotations?.['collabora-controller/draining'] === 'true';

          const backend: Backend = {
            url,
            podName,
            podIP,
            weight,
            draining,
            status: draining ? 'draining' : 'healthy',
            connections: this.backends.get(url)?.connections || 0,
            lastSeen: new Date()
          };

          newBackends.set(url, backend);
          this.logger.debug(`Discovered pod: ${podName} at ${url} (weight: ${weight}, draining: ${draining})`);
        }
      }

      // Update backends
      const oldUrls = new Set(this.backends.keys());
      const newUrls = new Set(newBackends.keys());

      // Remove backends that no longer exist
      for (const url of oldUrls) {
        if (!newUrls.has(url)) {
          this.logger.info(`Pod removed: ${url}`);
          this.backends.delete(url);
        }
      }

      // Add or update backends
      for (const [url, backend] of newBackends.entries()) {
        const existing = this.backends.get(url);
        if (existing) {
          // Preserve connection count
          backend.connections = existing.connections;
        }
        this.backends.set(url, backend);
      }

      // Notify callback if set
      if (this.updateCallback) {
        this.updateCallback(Array.from(this.backends.values()));
      }

      return Array.from(this.backends.values());
    } catch (error) {
      this.logger.error('Error discovering pods:', error);
      throw error;
    }
  }

  private getPodPort(pod: k8s.V1Pod): number | undefined {
    // Try to get port from container spec
    const container = pod.spec?.containers?.[0];
    if (container?.ports?.[0]?.containerPort) {
      return container.ports[0].containerPort;
    }
    
    // Default Collabora port
    return 9980;
  }

  async start(): Promise<void> {
    await this.initialize();
    
    // Initial discovery
    await this.discoverPods();
    
    // Set up periodic refresh
    this.discoveryInterval = setInterval(async () => {
      try {
        await this.discoverPods();
      } catch (error) {
        this.logger.error('Error in periodic discovery:', error);
      }
    }, 5000); // Refresh every 5 seconds

    // Set up watch for real-time updates
    try {
      await this.watchPods();
    } catch (error) {
      this.logger.warn('Failed to set up pod watch, using polling only:', error);
    }
  }

  private async watchPods(): Promise<void> {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const watch = new k8s.Watch(kc);

    const path = `/api/v1/namespaces/${this.namespace}/pods`;
    const queryParams = {
      labelSelector: `app=${this.serviceName}`
    };

    this.watch = watch;
    
    watch.watch(
      path,
      queryParams,
      async (type: string, obj: k8s.V1Pod) => {
        this.logger.debug(`Pod event: ${type} - ${obj.metadata?.name}`);
        // Refresh backends on any pod change
        await this.discoverPods();
      },
      (err: any) => {
        if (err) {
          this.logger.error('Watch error:', err);
          // Retry watch after delay
          setTimeout(() => this.watchPods(), 5000);
        }
      }
    );
  }

  async stop(): Promise<void> {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
    }
    if (this.watch) {
      // Watch doesn't have abort method, but we can stop by clearing the reference
      this.watch = null;
    }
  }

  getBackends(): Backend[] {
    return Array.from(this.backends.values());
  }

  onUpdate(callback: (backends: Backend[]) => void): void {
    this.updateCallback = callback;
  }
}
