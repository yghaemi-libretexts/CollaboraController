import DocumentAffinity from '../../lib/document-affinity';
import logger from '../../lib/logger';

// Mock redis client
const mockRedisClient = {
  isOpen: true,
  connect: jest.fn().mockResolvedValue(undefined),
  get: jest.fn(),
  setEx: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  scanIterator: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
  on: jest.fn()
};

jest.mock('redis', () => {
  return {
    createClient: jest.fn(() => mockRedisClient)
  };
});

describe('DocumentAffinity', () => {
  let documentAffinity: DocumentAffinity;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient.isOpen = true;
    documentAffinity = new DocumentAffinity({
      redisHost: 'localhost',
      redisPort: 6379,
      logger
    });
  });

  afterEach(async () => {
    await documentAffinity.close();
  });

  describe('initialize', () => {
    it('should initialize Redis client', async () => {
      await documentAffinity.initialize();
      expect(mockRedisClient.connect).toHaveBeenCalled();
    });

    it('should handle initialization errors', async () => {
      mockRedisClient.connect.mockRejectedValueOnce(new Error('Connection failed'));
      await expect(documentAffinity.initialize()).rejects.toThrow();
    });
  });

  describe('getAffinity', () => {
    beforeEach(async () => {
      await documentAffinity.initialize();
    });

    it('should return null when client is not connected', async () => {
      mockRedisClient.isOpen = false;
      const result = await documentAffinity.getAffinity('doc123');
      expect(result).toBeNull();
    });

    it('should return backend URL when affinity exists', async () => {
      mockRedisClient.get.mockResolvedValueOnce('http://backend1:9980');
      const result = await documentAffinity.getAffinity('doc123');
      expect(result).toBe('http://backend1:9980');
      expect(mockRedisClient.get).toHaveBeenCalledWith('doc:doc123');
    });

    it('should return null when affinity does not exist', async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);
      const result = await documentAffinity.getAffinity('doc123');
      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockRedisClient.get.mockRejectedValueOnce(new Error('Redis error'));
      const result = await documentAffinity.getAffinity('doc123');
      expect(result).toBeNull();
    });
  });

  describe('setAffinity', () => {
    beforeEach(async () => {
      await documentAffinity.initialize();
    });

    it('should set document affinity', async () => {
      await documentAffinity.setAffinity('doc123', 'http://backend1:9980');
      expect(mockRedisClient.setEx).toHaveBeenCalledWith(
        'doc:doc123',
        3600,
        'http://backend1:9980'
      );
    });

    it('should not set affinity when client is not connected', async () => {
      mockRedisClient.isOpen = false;
      await documentAffinity.setAffinity('doc123', 'http://backend1:9980');
      expect(mockRedisClient.setEx).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockRedisClient.setEx.mockRejectedValueOnce(new Error('Redis error'));
      await documentAffinity.setAffinity('doc123', 'http://backend1:9980');
      // Should not throw
    });
  });

  describe('removeAffinity', () => {
    beforeEach(async () => {
      await documentAffinity.initialize();
    });

    it('should remove document affinity', async () => {
      await documentAffinity.removeAffinity('doc123');
      expect(mockRedisClient.del).toHaveBeenCalledWith('doc:doc123');
    });

    it('should handle errors gracefully', async () => {
      mockRedisClient.del.mockRejectedValueOnce(new Error('Redis error'));
      await documentAffinity.removeAffinity('doc123');
      // Should not throw
    });
  });

  describe('removeBackendAffinities', () => {
    beforeEach(async () => {
      await documentAffinity.initialize();
    });

    it('should remove all affinities for a backend', async () => {
      async function* mockIterator() {
        yield 'doc:doc1';
        yield 'doc:doc2';
      }
      
      mockRedisClient.scanIterator.mockReturnValue(mockIterator());
      mockRedisClient.get
        .mockResolvedValueOnce('http://backend1:9980')
        .mockResolvedValueOnce('http://backend2:9980');

      await documentAffinity.removeBackendAffinities('http://backend1:9980');
      
      expect(mockRedisClient.scanIterator).toHaveBeenCalledWith({
        MATCH: 'doc:*',
        COUNT: 100
      });
      expect(mockRedisClient.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('close', () => {
    it('should close Redis client', async () => {
      await documentAffinity.initialize();
      await documentAffinity.close();
      expect(mockRedisClient.quit).toHaveBeenCalled();
    });

    it('should handle close when client is not initialized', async () => {
      await documentAffinity.close();
      // Should not throw
    });
  });
});
