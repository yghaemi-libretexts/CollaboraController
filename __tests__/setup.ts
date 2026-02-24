// Test setup file
// This file runs before all tests

// Mock environment variables
process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.COLLABORA_SERVICE = 'collabora';
process.env.COLLABORA_NAMESPACE = 'default';
