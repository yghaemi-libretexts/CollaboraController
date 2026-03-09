import { Logger } from 'winston';
import { Request, Response } from 'express';

export interface Backend {
  url: string;
  podName: string;
  serviceIP: string;
  weight: number;
  draining: boolean;
  status: 'healthy' | 'unhealthy' | 'draining';
  connections: number;
  lastSeen: Date;
}

export interface K8sDiscoveryOptions {
  namespace?: string;
  serviceName?: string;
  clusterName?: string;
  logger?: Logger;
}

export interface DocumentAffinityOptions {
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  logger?: Logger;
  ttl?: number;
}

export interface LoadBalancerOptions {
  k8sDiscovery: K8sDiscovery;
  documentAffinity: DocumentAffinity;
  strategy?: 'least-connections' | 'round-robin' | 'weighted';
  logger?: Logger;
}

export interface K8sDiscovery {
  getBackends(): Backend[];
  onUpdate(callback: (backends: Backend[]) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DocumentAffinity {
  initialize(): Promise<void>;
  getAffinity(documentId: string): Promise<string | null>;
  setAffinity(documentId: string, backendUrl: string): Promise<void>;
  removeAffinity(documentId: string): Promise<void>;
  removeBackendAffinities(backendUrl: string): Promise<void>;
  close(): Promise<void>;
}

export interface LoadBalancer {
  selectBackend(documentId?: string | null): Promise<Backend | null>;
  incrementConnections(backendUrl: string): void;
  decrementConnections(backendUrl: string): void;
  markBackendUnhealthy(backendUrl: string): void;
  markBackendHealthy(backendUrl: string): void;
  getBackends(): Promise<Backend[]>;
  drainBackend(backendUrl: string, timeout?: number): Promise<boolean>;
  start(): Promise<void>;
}
