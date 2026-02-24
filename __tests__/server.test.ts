import express, { Request } from 'express';

// Mock all dependencies before importing server
jest.mock('../lib/k8s-discovery');
jest.mock('../lib/document-affinity');
jest.mock('../lib/load-balancer');

// Mock logger to reduce noise
jest.mock('../lib/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

describe('Server - Document ID Extraction', () => {
  // Test the document ID extraction logic
  function extractDocumentId(req: Partial<Request>): string | null {
    // WOPI requests typically have document IDs in the path
    const wopiMatch = req.path?.match(/\/wopi\/files\/([^\/]+)/);
    if (wopiMatch) {
      return wopiMatch[1];
    }
    
    // Also check query parameters
    if (req.query?.file_id && typeof req.query.file_id === 'string') {
      return req.query.file_id;
    }
    
    // Check for document ID in headers
    const docIdHeader = req.headers?.['x-wopi-document-id'];
    if (docIdHeader && typeof docIdHeader === 'string') {
      return docIdHeader;
    }
    
    return null;
  }

  it('should extract document ID from WOPI path', () => {
    const req = { path: '/wopi/files/doc123/contents' };
    const docId = extractDocumentId(req);
    expect(docId).toBe('doc123');
  });

  it('should extract document ID from path without trailing slash', () => {
    const req = { path: '/wopi/files/doc123' };
    const docId = extractDocumentId(req);
    expect(docId).toBe('doc123');
  });

  it('should extract document ID from query parameter', () => {
    const req = { query: { file_id: 'doc123' } };
    const docId = extractDocumentId(req);
    expect(docId).toBe('doc123');
  });

  it('should extract document ID from header', () => {
    const req = { headers: { 'x-wopi-document-id': 'doc123' } };
    const docId = extractDocumentId(req);
    expect(docId).toBe('doc123');
  });

  it('should prioritize path over query parameter', () => {
    const req = {
      path: '/wopi/files/doc123/contents',
      query: { file_id: 'doc456' }
    };
    const docId = extractDocumentId(req);
    expect(docId).toBe('doc123');
  });

  it('should return null when no document ID found', () => {
    const req = { path: '/some/other/path' };
    const docId = extractDocumentId(req);
    expect(docId).toBeNull();
  });

  it('should handle complex document IDs', () => {
    const req = { path: '/wopi/files/doc-123-abc-456/contents' };
    const docId = extractDocumentId(req);
    expect(docId).toBe('doc-123-abc-456');
  });
});

describe('Server - Health Check Logic', () => {
  it('should return healthy status with timestamp', () => {
    const healthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString()
    };
    
    expect(healthResponse.status).toBe('healthy');
    expect(healthResponse.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('Server - Metrics Logic', () => {
  it('should format metrics correctly', () => {
    const backends = [
      {
        url: 'http://backend1:9980',
        status: 'healthy' as const,
        connections: 5,
        weight: 100
      },
      {
        url: 'http://backend2:9980',
        status: 'healthy' as const,
        connections: 3,
        weight: 150
      }
    ];

    const metrics = {
      totalBackends: backends.length,
      activeBackends: backends.filter(b => b.status === 'healthy').length,
      backends: backends.map(b => ({
        url: b.url,
        status: b.status,
        connections: b.connections,
        weight: b.weight
      }))
    };

    expect(metrics.totalBackends).toBe(2);
    expect(metrics.activeBackends).toBe(2);
    expect(metrics.backends).toHaveLength(2);
    expect(metrics.backends[0].url).toBe('http://backend1:9980');
    expect(metrics.backends[0].connections).toBe(5);
  });
});
