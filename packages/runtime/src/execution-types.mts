export type FixtureMode = 'complete' | 'fail' | 'wait';
export type RunState = 'queued' | 'running' | 'awaiting_approval' | 'cancelling' |
  'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ApprovalState = 'not_required' | 'pending' | 'approved' | 'rejected' | 'expired';

export interface FixtureRequest {
  workspace: string;
  commandId?: string;
  mode?: FixtureMode;
  durationMs?: number;
  scope?: 'trusted-workspace';
  roomId?: string;
  participantId?: string;
}

export interface CodexRequest {
  model?: string;
  projectId: string;
  prompt: string;
  commandId?: string;
  executable?: string;
  profile?: 'cli' | 'desktop';
  fileChangeWorkspaceId?: string;
  roomId?: string;
  participantId?: string;
}

export interface RunSnapshot {
  id: string;
  taskId: string;
  attemptId: string;
  roomId: string;
  participantId: string;
  commandId: string;
  workspace: string;
  mode: FixtureMode | 'codex-read-only';
  durationMs: number;
  scope: 'trusted-workspace' | 'read-only';
  state: RunState;
  approvalState: ApprovalState;
  ownerId: string;
  coordinatorPid: number;
  processPid: number | null;
  exitCode: number | null;
  errorCode: string | null;
  ownershipRetained: boolean;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AcceptedRun {
  duplicate: boolean;
  run: RunSnapshot;
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type: string;
  at: string;
  text?: string;
  [field: string]: unknown;
}

export interface ApprovalPreview {
  kind: 'file-change' | 'permissions' | 'command' | 'terminal-input';
  cwd?: string | null;
  command?: string | null;
  requestedRoot?: string | null;
  targets?: { action: string; path: string }[];
  paths?: { access: string; path: string }[];
  changes?: { action: string; path: string; moveTo?: string | null; diff?: string }[];
  networkRequested?: boolean;
  incomplete?: boolean;
}

export interface PendingApproval {
  approvalId: string;
  method: string;
  preview: ApprovalPreview | null;
}

export interface FileChange {
  target: string;
  original: string;
  replacement: string;
}
