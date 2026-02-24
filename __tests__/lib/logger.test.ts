import logger from '../../lib/logger';

describe('Logger', () => {
  it('should create a logger instance', () => {
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.debug).toBeDefined();
  });

  it('should log messages at different levels', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation();
    
    logger.info('Test info message');
    logger.error('Test error message');
    logger.warn('Test warn message');
    logger.debug('Test debug message');
    
    spy.mockRestore();
  });

  it('should have correct default metadata', () => {
    expect(logger.defaultMeta).toEqual({ service: 'collabora-controller' });
  });
});
