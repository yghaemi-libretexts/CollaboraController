import LoadBalancer from '../../lib/load-balancer';
import K8sDiscovery from '../../lib/k8s-discovery';
import DocumentAffinity from '../../lib/document-affinity';
import logger from '../../lib/logger';
import type { Backend } from '../../lib/types';

// Mock dependencies
jest.mock('../../lib/k8s-discovery');
jest.mock('../../lib/document-affinity');

describe('LoadBalancer', () => {
  let loadBalancer: LoadBalancer;
  let mockK8sDiscovery: jest.Mocked<K8sDiscovery>;
  let mockDocumentAffinity: jest.Mocked<DocumentAffinity>;

  const createMockBackend = (overrides?: Partial<Backend>): Backend => ({
    url: 'http://backend1:9980',
    podName: 'pod1',
    podIP: '10.0.0.1',
    weight: 100,
    draining: false,
    status: 'healthy',
    connections: 0,
    lastSeen: new Date(),
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockK8sDiscovery = {
      getBackends: jest.fn(),
      onUpdate: jest.fn()
    } as any;

    mockDocumentAffinity = {
      getAffinity: jest.fn(),
      setAffinity: jest.fn(),
      removeAffinity: jest.fn(),
      removeBackendAffinities: jest.fn().mockResolvedValue(undefined)
    } as any;

    loadBalancer = new LoadBalancer({
      k8sDiscovery: mockK8sDiscovery,
      documentAffinity: mockDocumentAffinity,
      strategy: 'least-connections',
      logger
    });
  });

  describe('start', () => {
    it('should register update callback and update backends', async () => {
      const backends = [createMockBackend()];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);

      await loadBalancer.start();

      expect(mockK8sDiscovery.onUpdate).toHaveBeenCalled();
      expect(mockK8sDiscovery.getBackends).toHaveBeenCalled();
    });
  });

  describe('selectBackend', () => {
    beforeEach(async () => {
      const backends = [
        createMockBackend({ url: 'http://backend1:9980', connections: 5 }),
        createMockBackend({ url: 'http://backend2:9980', connections: 2 }),
        createMockBackend({ url: 'http://0.0.0.0:9980', connections: 10 })
      ];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      await loadBalancer.start();
    });

    it('should use affinity backend when document ID is provided', async () => {
      mockDocumentAffinity.getAffinity.mockResolvedValue('http://backend1:9980');
      
      const backend = await loadBalancer.selectBackend('doc123');
      
      expect(backend).toBeDefined();
      expect(backend?.url).toBe('http://backend1:9980');
      expect(mockDocumentAffinity.getAffinity).toHaveBeenCalledWith('doc123');
    });

    it('should fallback to load balancing when affinity backend is unhealthy', async () => {
      mockDocumentAffinity.getAffinity.mockResolvedValue('http://backend1:9980');
      
      // Make backend1 unhealthy by updating backends
      const backends = [
        createMockBackend({ url: 'http://backend1:9980', status: 'unhealthy' }),
        createMockBackend({ url: 'http://backend2:9980', connections: 2 })
      ];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      const updateCallback = mockK8sDiscovery.onUpdate.mock.calls[0][0];
      updateCallback(backends);
      
      const backend = await loadBalancer.selectBackend('doc123');
      
      expect(backend?.url).toBe('http://backend2:9980');
      expect(mockDocumentAffinity.removeAffinity).toHaveBeenCalledWith('doc123');
    });

    it('should use least-connections strategy by default', async () => {
      const backend = await loadBalancer.selectBackend();
      
      expect(backend?.url).toBe('http://backend2:9980'); // Has least connections (2)
    });

    it('should return null when no backends available', async () => {
      mockK8sDiscovery.getBackends.mockReturnValue([]);
      const updateCallback = mockK8sDiscovery.onUpdate.mock.calls[0][0];
      updateCallback([]);
      
      const backend = await loadBalancer.selectBackend();
      
      expect(backend).toBeNull();
    });

    it('should exclude draining backends', async () => {
      const backends = [
        createMockBackend({ url: 'https://local.antecedentwriting.com', draining: true }),
        createMockBackend({ url: 'http://127.0.0.1:9980' })
      ];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      const updateCallback = mockK8sDiscovery.onUpdate.mock.calls[0][0];
      updateCallback(backends);
      
      const backend = await loadBalancer.selectBackend();
      
      expect(backend?.url).toBe('http://127.0.0.1:9980');
    });
  });

  describe('round-robin strategy', () => {
    beforeEach(async () => {
      loadBalancer = new LoadBalancer({
        k8sDiscovery: mockK8sDiscovery,
        documentAffinity: mockDocumentAffinity,
        strategy: 'round-robin',
        logger
      });

      const backends = [
        createMockBackend({ url: 'https://local.antecedentwriting.com' }),
        createMockBackend({ url: 'http://127.0.0.1:9980' }),
        createMockBackend({ url: 'http://0.0.0.0:9980' })
      ];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      await loadBalancer.start();
    });

    it('should rotate through backends', async () => {
      const backend1 = await loadBalancer.selectBackend();
      const backend2 = await loadBalancer.selectBackend();
      const backend3 = await loadBalancer.selectBackend();
      const backend4 = await loadBalancer.selectBackend();
      
      expect(backend1?.url).toBe('https://local.antecedentwriting.com');
      expect(backend2?.url).toBe('http://127.0.0.1:9980');
      expect(backend3?.url).toBe('http://0.0.0.0:9980');
      expect(backend4?.url).toBe('https://local.antecedentwriting.com'); // Wraps around
    });
  });

  describe('weighted strategy', () => {
    beforeEach(async () => {
      loadBalancer = new LoadBalancer({
        k8sDiscovery: mockK8sDiscovery,
        documentAffinity: mockDocumentAffinity,
        strategy: 'weighted',
        logger
      });

      const backends = [
        createMockBackend({ url: 'https://local.antecedentwriting.com', weight: 50 }),
        createMockBackend({ url: 'http://127.0.0.1:9980', weight: 100 }),
        createMockBackend({ url: 'http://0.0.0.0:9980', weight: 150 })
      ];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      await loadBalancer.start();
    });

    it('should select backend based on weights', async () => {
      // Weighted selection is probabilistic, so we test multiple times
      const selections: string[] = [];
      for (let i = 0; i < 100; i++) {
        const backend = await loadBalancer.selectBackend();
        if (backend) selections.push(backend.url);
      }
      
      // Should select at least one backend
      expect(selections.length).toBeGreaterThan(0);
      // All selections should be valid backends
      expect(selections.every(url => 
        ['https://local.antecedentwriting.com', 'http://127.0.0.1:9980', 'http://0.0.0.0:9980'].includes(url)
      )).toBe(true);
    });
  });

  describe('connection tracking', () => {
    beforeEach(async () => {
      const backends = [createMockBackend({ url: 'https://local.antecedentwriting.com', connections: 0 })];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      await loadBalancer.start();
    });

    it('should increment connections', async () => {
      loadBalancer.incrementConnections('https://local.antecedentwriting.com');
      const backends = await loadBalancer.getBackends();
      const backend = backends.find(b => b.url === 'https://local.antecedentwriting.com');
      expect(backend?.connections).toBe(1);
    });

    it('should decrement connections', async () => {
      loadBalancer.incrementConnections('https://local.antecedentwriting.com');
      loadBalancer.incrementConnections('https://local.antecedentwriting.com');
      loadBalancer.decrementConnections('https://local.antecedentwriting.com');
      
      const backends = await loadBalancer.getBackends();
      const backend = backends.find(b => b.url === 'https://local.antecedentwriting.com');
      expect(backend?.connections).toBe(1);
    });

    it('should not allow negative connections', async () => {
      loadBalancer.decrementConnections('https://local.antecedentwriting.com');
      
      const backends = await loadBalancer.getBackends();
      const backend = backends.find(b => b.url === 'https://local.antecedentwriting.com');
      expect(backend?.connections).toBe(0);
    });
  });

  describe('backend health', () => {
    beforeEach(async () => {
      const backends = [createMockBackend({ url: 'https://local.antecedentwriting.com' })];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      await loadBalancer.start();
    });

    it('should mark backend as unhealthy', async () => {
      loadBalancer.markBackendUnhealthy('https://local.antecedentwriting.com');
      const backends = await loadBalancer.getBackends();
      const backend = backends.find(b => b.url === 'https://local.antecedentwriting.com');
      expect(backend?.status).toBe('unhealthy');
    });

    it('should mark backend as healthy', async () => {
      loadBalancer.markBackendUnhealthy('https://local.antecedentwriting.com');
      loadBalancer.markBackendHealthy('https://local.antecedentwriting.com');
      const backends = await loadBalancer.getBackends();
      const backend = backends.find(b => b.url === 'https://local.antecedentwriting.com');
      expect(backend?.status).toBe('healthy');
    });
  });

  describe('drainBackend', () => {
    beforeEach(async () => {
      const backends = [createMockBackend({ url: 'https://local.antecedentwriting.com', connections: 3 })];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      await loadBalancer.start();
    });

    it('should mark backend as draining', async () => {
      const drainPromise = loadBalancer.drainBackend('https://local.antecedentwriting.com', 100);
      
      // Immediately check status
      const backends = await loadBalancer.getBackends();
      const backend = backends.find(b => b.url === 'https://local.antecedentwriting.com');
      expect(backend?.draining).toBe(true);
      expect(backend?.status).toBe('draining');
      
      // Wait for drain to complete
      await drainPromise;
    });

    it('should throw error for non-existent backend', async () => {
      await expect(loadBalancer.drainBackend('http://nonexistent:9980')).rejects.toThrow();
    });

    it('should wait for connections to drain', async () => {
      loadBalancer.incrementConnections('https://local.antecedentwriting.com');
      loadBalancer.incrementConnections('https://local.antecedentwriting.com');
      
      const drainPromise = loadBalancer.drainBackend('https://local.antecedentwriting.com', 5000);
      
      // Manually decrement connections to simulate drain
      setTimeout(() => {
        loadBalancer.decrementConnections('https://local.antecedentwriting.com');
        loadBalancer.decrementConnections('https://local.antecedentwriting.com');
      }, 100);
      
      const result = await drainPromise;
      expect(result).toBe(true);
    });
  });

  describe('getBackends', () => {
    it('should return all backends', async () => {
      const backends = [
        createMockBackend({ url: 'https://local.antecedentwriting.com' }),
        createMockBackend({ url: 'http://127.0.0.1:9980' })
      ];
      mockK8sDiscovery.getBackends.mockReturnValue(backends);
      await loadBalancer.start();
      
      const result = await loadBalancer.getBackends();
      expect(result).toHaveLength(2);
    });
  });
});
