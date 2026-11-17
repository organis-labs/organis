import type { FileChange } from './execution-types.mjs';

export interface CollaborationRequest {
  projectId: string;
  request: string;
  commandId: string;
}

export interface TestRecord {
  command: string;
  actor: string;
  exitCode: number;
  result: string;
  revision: string;
}

export interface RecordTestRequest extends TestRecord {
  id: string;
  attempt: number;
}

export type CollaborationPhase = 'ready-to-plan' | 'planning' | 'ready-to-propose' | 'proposing' |
  'awaiting-approval' | 'applying' | 'ready-to-review' | 'reviewing' | 'revision-requested' |
  'verification-required' | 'cancelling' | 'completed' | 'failed' | 'cancelled' |
  'interrupted' | 'revision-limit';

export interface CollaborationPlan {
  summary: string;
  instructions: string;
  criteria: string[];
}

export interface CollaborationReview {
  verdict: 'passed' | 'failed' | 'revision';
  summary: string;
}

export interface CollaborationRun {
  id: string;
  runId?: string;
  stage: 'plan' | 'codex' | 'apply' | 'review';
  attempt: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  approvedAt?: number;
  commandId?: string;
  errorCode?: string;
}

export interface CollaborationSnapshot {
  id: string;
  roomId: string;
  participants: { claude: string; codex: string };
  projectId: string;
  target: string;
  fileName: string;
  request: string;
  original: string;
  attempt: number;
  revisionLimit: number;
  phase: CollaborationPhase;
  message: string;
  createdAt: number;
  updatedAt: number;
  tests: TestRecord[];
  runs: CollaborationRun[];
  history: { proposal: FileChange; review: CollaborationReview; tests: TestRecord[]; revision: string; appliedAt: number }[];
  applied: boolean;
  canAcknowledgeUncertainWrite: boolean;
  plan?: CollaborationPlan;
  instructions?: string;
  proposal?: FileChange;
  approvalExpiresAt?: number;
  appliedAt?: number;
  revision?: string;
  review?: CollaborationReview;
}
