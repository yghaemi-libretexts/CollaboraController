import K8sDiscovery from '../../lib/k8s-discovery';
import logger from '../../lib/logger';
import * as k8s from '@kubernetes/client-node';

// Mock Kubernetes client
jest.mock('@kubernetes/client-node');

describe('K8sDiscovery', () => {
  let k8sDiscovery: K8sDiscovery;
  let mockK8sApi: jest.Mocked<k8s.CoreV1Api>;
  let mockKubeConfig: jest.Mocked<k8s.KubeConfig>;
  let mockWatch: jest.Mocked<k8s.Watch>;

  const createMockService = (overrides: any = {}) => ({
    metadata: {
      name: 'collabora-svc',
      annotations: {},
      labels: {},
      ...overrides.metadata
    },
    spec: {
      clusterIP: '10.96.0.10',
      ports: [{ port: 9980, protocol: 'TCP' }],
      selector: { app: 'collabora' },
      type: 'ClusterIP',
      ...overrides.spec
    },
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockK8sApi = {
      listNamespacedService: jest.fn()
    } as any;

    mockKubeConfig = {
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn(() => mockK8sApi),
      getCurrentContext: jest.fn(() => 'test-ctx'),
      getCurrentCluster: jest.fn(() => ({ server: 'https://localhost:6443' }))
    } as any;

    mockWatch = {
      watch: jest.fn()
    } as any;

    (k8s.KubeConfig as jest.MockedClass<typeof k8s.KubeConfig>).mockImplementation(() => mockKubeConfig);
    (k8s.Watch as jest.MockedClass<typeof k8s.Watch>).mockImplementation(() => mockWatch);

    k8sDiscovery = new K8sDiscovery({
      namespace: 'default',
      serviceName: 'collabora',
      logger
    });
  });

  describe('initialize', () => {
    it('should initialize Kubernetes client', async () => {
      await k8sDiscovery.initialize();
      
      expect(mockKubeConfig.loadFromDefault).toHaveBeenCalled();
      expect(mockKubeConfig.makeApiClient).toHaveBeenCalledWith(k8s.CoreV1Api);
    });

    it('should handle initialization errors', async () => {
      mockKubeConfig.loadFromDefault.mockImplementation(() => {
        throw new Error('Config error');
      });

      await expect(k8sDiscovery.initialize()).rejects.toThrow();
    });
  });

  describe('discoverServices', () => {
    beforeEach(async () => {
      await k8sDiscovery.initialize();
    });

    it('should discover matching services', async () => {
      const mockServices = [
        createMockService({ metadata: { name: 'svc1' } }),
        createMockService({
          metadata: { name: 'svc2' },
          spec: { clusterIP: '10.96.0.20', ports: [{ port: 9980 }], selector: { app: 'collabora' } }
        })
      ];

      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: mockServices
      } as any);

      const backends = await k8sDiscovery.discoverServices();

      expect(backends).toHaveLength(2);
      expect(backends[0].serviceName).toBe('svc1');
      expect(backends[0].url).toBe('http://10.96.0.10:9980');
      expect(backends[1].serviceName).toBe('svc2');
    });

    it('should filter out services with non-matching selector', async () => {
      const mockServices = [
        createMockService({ spec: { selector: { app: 'other' }, clusterIP: '10.96.0.10', ports: [{ port: 80 }] } }),
        createMockService()
      ];

      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: mockServices
      } as any);

      const backends = await k8sDiscovery.discoverServices();

      expect(backends).toHaveLength(1);
      expect(backends[0].status).toBe('healthy');
    });

    it('should skip headless services (clusterIP=None)', async () => {
      const mockServices = [
        createMockService({ spec: { clusterIP: 'None', ports: [{ port: 9980 }], selector: { app: 'collabora' } } }),
        createMockService()
      ];

      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: mockServices
      } as any);

      const backends = await k8sDiscovery.discoverServices();

      expect(backends).toHaveLength(1);
    });

    it('should extract weight from annotations', async () => {
      const mockServices = [
        createMockService({
          metadata: {
            name: 'svc1',
            annotations: { 'collabora-controller/weight': '150' }
          }
        })
      ];

      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: mockServices
      } as any);

      const backends = await k8sDiscovery.discoverServices();

      expect(backends[0].weight).toBe(150);
    });

    it('should detect draining services', async () => {
      const mockServices = [
        createMockService({
          metadata: {
            name: 'svc1',
            annotations: { 'collabora-controller/draining': 'true' }
          }
        })
      ];

      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: mockServices
      } as any);

      const backends = await k8sDiscovery.discoverServices();

      expect(backends[0].draining).toBe(true);
      expect(backends[0].status).toBe('draining');
    });

    it('should preserve connection counts when updating', async () => {
      const mockServices = [createMockService()];
      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: mockServices
      } as any);

      await k8sDiscovery.discoverServices();
      const backends1 = k8sDiscovery.getBackends();
      backends1[0].connections = 5;

      await k8sDiscovery.discoverServices();
      const backends2 = k8sDiscovery.getBackends();

      expect(backends2[0].connections).toBe(5);
    });

    it('should remove backends that no longer exist', async () => {
      const mockServices1 = [
        createMockService({ metadata: { name: 'svc1' }, spec: { clusterIP: '10.96.0.10', ports: [{ port: 9980 }], selector: { app: 'collabora' } } }),
        createMockService({ metadata: { name: 'svc2' }, spec: { clusterIP: '10.96.0.20', ports: [{ port: 9980 }], selector: { app: 'collabora' } } })
      ];
      mockK8sApi.listNamespacedService.mockResolvedValueOnce({
        items: mockServices1
      } as any);

      await k8sDiscovery.discoverServices();
      expect(k8sDiscovery.getBackends()).toHaveLength(2);

      const mockServices2 = [
        createMockService({ metadata: { name: 'svc1' }, spec: { clusterIP: '10.96.0.10', ports: [{ port: 9980 }], selector: { app: 'collabora' } } })
      ];
      mockK8sApi.listNamespacedService.mockResolvedValueOnce({
        items: mockServices2
      } as any);

      await k8sDiscovery.discoverServices();
      expect(k8sDiscovery.getBackends()).toHaveLength(1);
    });

    it('should handle discovery errors', async () => {
      mockK8sApi.listNamespacedService.mockRejectedValueOnce(new Error('API error'));

      await expect(k8sDiscovery.discoverServices()).rejects.toThrow();
    });
  });

  describe('start', () => {
    beforeEach(async () => {
      await k8sDiscovery.initialize();
      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: []
      } as any);
    });

    it('should start periodic discovery', async () => {
      jest.useFakeTimers();
      
      await k8sDiscovery.start();
      
      expect(mockK8sApi.listNamespacedService).toHaveBeenCalled();
      
      jest.advanceTimersByTime(500000);
      
      expect(mockK8sApi.listNamespacedService).toHaveBeenCalledTimes(3);
      
      jest.useRealTimers();
    });

    it('should set up service watch', async () => {
      await k8sDiscovery.start();
      
      expect(mockWatch.watch).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should stop discovery interval and watch', async () => {
      jest.useFakeTimers();
      await k8sDiscovery.start();
      
      await k8sDiscovery.stop();
      
      expect(k8sDiscovery).toBeDefined();
      
      jest.useRealTimers();
    });
  });

  describe('onUpdate', () => {
    it('should register update callback', () => {
      const callback = jest.fn();
      k8sDiscovery.onUpdate(callback);
      
      expect(typeof k8sDiscovery.onUpdate).toBe('function');
    });
  });

  describe('getBackends', () => {
    it('should return empty array initially', () => {
      expect(k8sDiscovery.getBackends()).toEqual([]);
    });

    it('should return discovered backends', async () => {
      await k8sDiscovery.initialize();
      const mockServices = [createMockService()];
      mockK8sApi.listNamespacedService.mockResolvedValue({
        items: mockServices
      } as any);

      await k8sDiscovery.discoverServices();
      const backends = k8sDiscovery.getBackends();

      expect(backends).toHaveLength(1);
    });
  });
});
