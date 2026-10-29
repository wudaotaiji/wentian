/** 共通基盤（Personal Cloud）の契約。容量はバイト、時刻はUTC、所有者は認証側で決定します。 */
export type Engine = 'docker' | 'podman';
export interface Capabilities {
  os: string; arch: string; cpuCores: number; memoryBytes: number; freeMemoryBytes: number;
  observedAt: string; runtimes: Array<{engine: Engine; ready: boolean; version?: string; reason?: string}>;
  gpus: Array<{name: string; freeBytes: number; totalBytes: number; verified: boolean;index?:number;engines?:Engine[]}>;
  ai: Array<{kind: string; ready: boolean}>;
}
export interface CloudNode {
  id: string; ownerId: string; name: string; publicKey: string; approved: boolean; revoked: boolean;
  capabilities?: Capabilities; lastSeenAt?: string; createdAt: string;
}
export interface AppSpec {
  name: string; image: string; engine: Engine; containerPort: number; healthPath: string;
  cpuCores: number; memoryBytes: number; gpuMemoryBytes: number; arch?: string;
  environment: Record<string,string>;
}
export type AppAction = 'deploy' | 'start' | 'stop' | 'rollback' | 'delete' | 'publish' | 'unpublish';
export interface CloudApp {
  id: string; ownerId: string; nodeId: string; spec: AppSpec; revision: number;
  desiredState: 'running' | 'stopped' | 'deleted'; state: string; localUrl?: string;
  publicUrl?: string; publication: string; error?: string; createdAt: string;
  gpuIndex?:number;
  deploymentId?:string;
}
export interface CloudJob {
  id: string; ownerId: string; nodeId: string; appId: string; action: AppAction; spec: AppSpec;
  status: 'queued' | 'running' | 'succeeded' | 'failed'; createdAt: string; deadlineAt: string;
  requestHash: string; idempotencyKey: string; lease?: string; leaseUntil?: string; attempt: number;
  publication?: {mode: 'quick' | 'named'; anonymous: boolean; hostname?: string; allowedEmails?:string[]};
  result?: JobResult;
  gpuIndex?:number;
}
export interface JobResult {
  state: string; localUrl?: string; publicUrl?: string; publication?: string; error?: string; imageDigest?: string;
  deploymentId?:string;
}
export interface Audit {id: string; ownerId: string; action: string; resourceId: string; at: string; result: string}
export interface CloudState {
  version: 1; nodes: CloudNode[]; apps: CloudApp[]; jobs: CloudJob[]; audit: Audit[];
  codes: Array<{hash: string; ownerId: string; name: string; expires: number}>;
  nonces: Array<{nodeId: string; nonce: string; expires: number}>;
}
export class CloudError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
export const iso = () => new Date().toISOString();
export const emptyCloudState = (): CloudState => ({version:1,nodes:[],apps:[],jobs:[],audit:[],codes:[],nonces:[]});
