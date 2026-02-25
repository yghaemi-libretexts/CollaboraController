import { EKSClient, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromEnv } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import logger from './logger';

export function createEksClient(region?: string): EKSClient {
  const resolvedRegion = region || process.env.AWS_REGION || 'us-east-1';
  return new EKSClient({
    region: resolvedRegion,
    credentials: fromEnv(),
  });
}

export interface EKSClusterConfig {
  endpoint: string;
  caData: string;
  token: string;
}

/**
 * Fetches EKS cluster details and generates a presigned STS bearer token.
 * Tokens are valid for ~15 minutes — callers should refresh periodically.
 */
export async function getEKSClusterConfig(
  clusterName: string,
  region?: string
): Promise<EKSClusterConfig> {
  const resolvedRegion = region || process.env.AWS_REGION || 'us-east-1';
  const eksClient = createEksClient(resolvedRegion);

  // 1. Fetch cluster endpoint + CA
  logger.info('Fetching EKS cluster info', { clusterName, region: resolvedRegion });
  const { cluster } = await eksClient.send(
    new DescribeClusterCommand({ name: clusterName })
  );

  if (!cluster?.endpoint || !cluster?.certificateAuthority?.data) {
    throw new Error(`EKS cluster "${clusterName}" missing endpoint or CA data`);
  }

  logger.info('EKS cluster info retrieved', {
    clusterName,
    endpoint: cluster.endpoint,
    status: cluster.status,
  });

  // 2. Generate presigned STS GetCallerIdentity URL (k8s-aws-v1.<base64url>)
  const token = await generateEKSToken(clusterName, resolvedRegion);

  return {
    endpoint: cluster.endpoint,
    caData: cluster.certificateAuthority.data,
    token,
  };
}

/**
 * Generates a bearer token for EKS by pre-signing an STS GetCallerIdentity
 * request, exactly matching the format that `aws eks get-token` produces.
 */
export async function generateEKSToken(
  clusterName: string,
  region: string
): Promise<string> {
  const stsHostname = `sts.${region}.amazonaws.com`;

  const credentials = await fromEnv()();
  const signer = new SignatureV4({
    credentials,
    region,
    service: 'sts',
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: stsHostname,
    path: '/',
    headers: {
      host: stsHostname,
      'x-k8s-aws-id': clusterName,
    },
    query: {
      Action: 'GetCallerIdentity',
      Version: '2011-06-15',
    },
  });

  const presigned = await signer.presign(request, { expiresIn: 60 });

  // Reconstruct the full URL from the presigned HttpRequest
  const query = presigned.query as Record<string, string>;
  const urlParams = new URLSearchParams(query).toString();
  const presignedUrl = `https://${stsHostname}/?${urlParams}`;
  const token = 'k8s-aws-v1.' + Buffer.from(presignedUrl).toString('base64url');

  logger.info('EKS bearer token generated', { clusterName, stsEndpoint: stsHostname });
  return token;
}
