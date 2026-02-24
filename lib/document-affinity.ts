import { createClient, RedisClientType } from 'redis';
import logger from './logger';
import type { Logger } from 'winston';
import type { DocumentAffinityOptions } from './types';

export default class DocumentAffinity {
  private redisHost: string;
  private redisPort: number;
  private redisPassword: string;
  private logger: Logger;
  private client: RedisClientType | null = null;
  private ttl: number;

  constructor(options: DocumentAffinityOptions = {}) {
    this.redisHost = options.redisHost || 'localhost';
    this.redisPort = options.redisPort || 6379;
    this.redisPassword = options.redisPassword || '';
    this.logger = options.logger || logger;
    this.ttl = options.ttl || 3600; // 1 hour default TTL
  }

  async initialize(): Promise<void> {
    try {
      const config: any = {
        socket: {
          host: this.redisHost,
          port: this.redisPort
        }
      };

      if (this.redisPassword) {
        config.password = this.redisPassword;
      }

      this.client = createClient(config) as RedisClientType;

      this.client.on('error', (err: Error) => {
        this.logger.error('Redis client error:', err);
      });

      this.client.on('connect', () => {
        this.logger.info('Redis client connected');
      });

      await this.client.connect();
      this.logger.info(`Redis client initialized: ${this.redisHost}:${this.redisPort}`);
    } catch (error) {
      this.logger.error('Failed to initialize Redis client:', error);
      throw error;
    }
  }

  async getAffinity(documentId: string): Promise<string | null> {
    if (!this.client || !this.client.isOpen) {
      this.logger.warn('Redis client not connected, returning null affinity');
      return null;
    }

    try {
      const key = `doc:${documentId}`;
      const backendUrl = await this.client.get(key);
      
      if (backendUrl) {
        this.logger.debug(`Found affinity for document ${documentId}: ${backendUrl}`);
        return backendUrl;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error getting affinity for document ${documentId}:`, error);
      return null;
    }
  }

  async setAffinity(documentId: string, backendUrl: string): Promise<void> {
    if (!this.client || !this.client.isOpen) {
      this.logger.warn('Redis client not connected, skipping affinity set');
      return;
    }

    try {
      const key = `doc:${documentId}`;
      await this.client.setEx(key, this.ttl, backendUrl);
      this.logger.debug(`Set affinity for document ${documentId} to ${backendUrl}`);
    } catch (error) {
      this.logger.error(`Error setting affinity for document ${documentId}:`, error);
    }
  }

  async removeAffinity(documentId: string): Promise<void> {
    if (!this.client || !this.client.isOpen) {
      return;
    }

    try {
      const key = `doc:${documentId}`;
      await this.client.del(key);
      this.logger.debug(`Removed affinity for document ${documentId}`);
    } catch (error) {
      this.logger.error(`Error removing affinity for document ${documentId}:`, error);
    }
  }

  async removeBackendAffinities(backendUrl: string): Promise<void> {
    if (!this.client || !this.client.isOpen) {
      return;
    }

    try {
      // Scan for all document keys
      const keys: string[] = [];
      for await (const key of this.client.scanIterator({
        MATCH: 'doc:*',
        COUNT: 100
      })) {
        const value = await this.client.get(key);
        if (value === backendUrl) {
          keys.push(key);
        }
      }

      // Delete all matching keys
      if (keys.length > 0) {
        await this.client.del(keys);
        this.logger.info(`Removed ${keys.length} affinities for backend ${backendUrl}`);
      }
    } catch (error) {
      this.logger.error(`Error removing backend affinities for ${backendUrl}:`, error);
    }
  }

  async close(): Promise<void> {
    if (this.client && this.client.isOpen) {
      await this.client.quit();
      this.logger.info('Redis client closed');
    }
  }
}
