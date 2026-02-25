import * as k8s from '@kubernetes/client-node';
import logger from './logger';
import type { Logger } from 'winston';
import type { Backend, K8sDiscoveryOptions } from './types';
import { getEKSClusterConfig, generateEKSToken } from './aws';

// Token refreshes 1 minute before the 15-minute EKS expiry
const TOKEN_REFRESH_INTERVAL_MS = 14 * 60 * 1000;

export default class K8sDiscovery {
  private namespace: string;
  private serviceName: string;
  private clusterName: string;
  private logger: Logger;
  private kc: k8s.KubeConfig | null = null;  // shared, single instance
  private k8sApi: k8s.CoreV1Api | null = null;
  private watch: k8s.Watch | null = null;
  private backends: Map<string, Backend> = new Map();
  private updateCallback: ((backends: Backend[]) => void) | null = null;
  private discoveryInterval: NodeJS.Timeout | null = null;
  private tokenRefreshInterval: NodeJS.Timeout | null = null;
  private useEKS: boolean;

  constructor(options: K8sDiscoveryOptions = {}) {
    this.namespace = options.namespace || 'default';
    this.serviceName = options.serviceName || 'collabora';
    this.clusterName = options.clusterName || process.env.EKS_CLUSTER_NAME || '';
    this.logger = options.logger || logger;
    this.useEKS = !!(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      this.clusterName
    );

    if (this.useEKS) {
      this.logger.info('EKS mode: will authenticate via AWS credentials', {
        clusterName: this.clusterName,
      });
    }
  }

  async initialize(): Promise<void> {
    try {
      this.kc = new k8s.KubeConfig();

      if (this.useEKS) {
        await this.loadEKSConfig();
      } else {
        this.kc.loadFromDefault();
      }

      this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);

      const ctx = this.kc.getCurrentContext();
      const cluster = this.kc.getCurrentCluster();
      this.logger.info('Kubernetes client initialized', {
        context: ctx,
        server: cluster?.server ?? 'unknown',
      });
    } catch (error) {
      this.logger.error('Failed to initialize Kubernetes client:', error);
      throw error;
    }
  }

  /**
   * Fetches a fresh EKS token and (re)builds the KubeConfig.
   * Called on startup and every TOKEN_REFRESH_INTERVAL_MS.
   */
  private async loadEKSConfig(): Promise<void> {
    const region = process.env.AWS_REGION || 'us-east-1';

    const { endpoint, caData, token } = await getEKSClusterConfig(
      this.clusterName,
      region
    );

    this.kc!.loadFromOptions({
      clusters: [
        {
          name: this.clusterName,
          server: endpoint,
          caData,
          skipTLSVerify: false,
        },
      ],
      users: [{ name: 'eks-user', token }],
      contexts: [
        {
          name: 'eks-ctx',
          cluster: this.clusterName,
          user: 'eks-user',
        },
      ],
      currentContext: 'eks-ctx',
    });

    this.k8sApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    this.logger.info('EKS kubeconfig loaded', {
      cluster: this.clusterName,
      server: endpoint,
    });
  }

  async discoverPods(): Promise<Backend[]> {
    const serviceBackends = new Map<string, Backend>();

    if (!this.k8sApi) {
      await this.initialize();
    }

    try {
      this.logger.info('Listing pods', {
        namespace: this.namespace,
        labelSelector: `app=${this.serviceName}`,
      });

      const response = await this.k8sApi!.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `app=${this.serviceName}`,
      });
      try{

         const serviceResponse = await this.k8sApi!.listNamespacedService({
          namespace: this.namespace,
          // labelSelector: `app=${this.serviceName}`,
        });
        const services = serviceResponse.items || [];
        services.filter(service => service.spec?.selector?.app === this.serviceName).forEach(service => {
          const serviceName = service.metadata?.name || '';
          const serviceIP = service.spec?.clusterIP || '';
          const servicePort = service.spec?.ports?.[0]?.port || 0;
          const serviceProtocol = service.spec?.ports?.[0]?.protocol || 'TCP';
          const serviceType = service.spec?.type || 'ClusterIP';
          const serviceSelector = service.spec?.selector || {};
          const serviceAnnotations = service.metadata?.annotations || {};
          const serviceLabels = service.metadata?.labels || {};
          console.log('Service:', {
            
            name: serviceName,
            ip: serviceIP,
            port: servicePort,
            protocol: serviceProtocol,
            type: serviceType,
            selector: serviceSelector,
            annotations: serviceAnnotations,
            labels: serviceLabels,
          });
          serviceBackends.set(serviceName, {
            url: `http://${serviceIP}:${servicePort}`,
            podName: serviceName,
            podIP: serviceIP,
            weight: 100,
            draining: false,
            status: 'healthy',
            connections: 0,
            lastSeen: new Date(),
          });
        });
      
     

      } catch (error) {
        this.logger.error('Error reading service:', error);
      }
     

      const pods = response.items || [];
      this.logger.info(`K8s API returned ${pods.length} pod(s) matching selector`);

      const newBackends = new Map<string, Backend>();
      

      for (const pod of pods) {
        const podName = pod.metadata?.name || '';
        const podIP = pod.status?.podIP;
        const phase = pod.status?.phase;
        const ready =
          pod.status?.conditions?.find(
            (c: k8s.V1PodCondition) => c.type === 'Ready'
          )?.status === 'True';

        this.logger.info(`  pod ${podName}: phase=${phase} ready=${ready} ip=${podIP || 'none'}`);

        if (phase === 'Running' && ready && podIP) {
          const port = this.getPodPort(pod) || 9980;
          const url = `http://${podIP}:${port}`;
          const weight = parseInt(
            pod.metadata?.annotations?.['collabora-controller/weight'] || '100',
            10
          );
          const draining =
            pod.metadata?.annotations?.['collabora-controller/draining'] === 'true';

          const backend: Backend = {
            url,
            podName,
            podIP,
            weight,
            draining,
            status: draining ? 'draining' : 'healthy',
            connections: this.backends.get(url)?.connections || 0,
            lastSeen: new Date(),
          };

          newBackends.set(url, backend);
          this.logger.info(`  -> registered backend ${podName} at ${url}`);
        }
      }

      for (const url of this.backends.keys()) {
        if (!newBackends.has(url)) {
          this.logger.info(`Pod removed: ${url}`);
          this.backends.delete(url);
        }
      }

      for (const [url, backend] of newBackends.entries()) {
        const existing = this.backends.get(url);
        if (existing) backend.connections = existing.connections;
        this.backends.set(url, backend);
      }

      this.logger.info(`Discovery complete: ${this.backends.size} active backend(s)`);
      this.updateCallback?.(Array.from(this.backends.values()));
      return Array.from(this.backends.values());
    } catch (error) {
      this.logger.error('Error discovering pods:', error);
      throw error;
    }
  }

  private getPodPort(pod: k8s.V1Pod): number | undefined {
    return pod.spec?.containers?.[0]?.ports?.[0]?.containerPort ?? 9980;
  }

  async start(): Promise<void> {
    await this.initialize();
    await this.discoverPods();

    // Periodic pod refresh
    this.discoveryInterval = setInterval(async () => {
      try {
        await this.discoverPods();
      } catch (error) {
        this.logger.error('Error in periodic discovery:', error);
      }
    }, 500000);

    // Refresh EKS token before it expires (every 14 min)
    if (this.useEKS) {
      this.tokenRefreshInterval = setInterval(async () => {
        try {
          await this.loadEKSConfig();
        } catch (error) {
          this.logger.error('Failed to refresh EKS token:', error);
        }
      }, TOKEN_REFRESH_INTERVAL_MS);
    }

    try {
      await this.watchPods();
    } catch (error) {
      this.logger.warn('Failed to set up pod watch, using polling only:', error);
    }
  }

  private async watchPods(): Promise<void> {
    if (!this.kc) throw new Error('KubeConfig not initialized');

    // Reuse the same authenticated KubeConfig — not a second loadFromDefault()
    const watch = new k8s.Watch(this.kc);
    this.watch = watch;

    watch.watch(
      `/api/v1/namespaces/${this.namespace}/pods`,
      { labelSelector: `app=${this.serviceName}` },
      async (type: string, obj: k8s.V1Pod) => {
        this.logger.debug(`Pod event: ${type} - ${obj.metadata?.name}`);
        await this.discoverPods();
      },
      (err: any) => {
        if (err) {
          this.logger.error('Watch error:', err);
          setTimeout(() => this.watchPods(), 5000);
        }
      }
    );
  }

  async stop(): Promise<void> {
    if (this.discoveryInterval) clearInterval(this.discoveryInterval);
    if (this.tokenRefreshInterval) clearInterval(this.tokenRefreshInterval);
    this.watch = null;
  }

  getBackends(): Backend[] {
    return Array.from(this.backends.values());
  }

  onUpdate(callback: (backends: Backend[]) => void): void {
    this.updateCallback = callback;
  }
}