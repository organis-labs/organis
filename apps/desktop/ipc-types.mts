import type { AcceptedRun, FileChange, FixtureMode, PendingApproval, RunEvent, RunSnapshot, RunState }
  from '../../packages/runtime/src/execution-types.mjs';
import type { CollaborationRequest, CollaborationSnapshot, RecordTestRequest }
  from '../../packages/runtime/src/collaboration-types.mjs';

interface CodexResult {
  state: RunState;
  answer?: string;
  approval: PendingApproval | null;
  errorCode: string | null;
  ownershipRetained: boolean;
}

export interface ExecutionIpc {
  chooseWorkspace(): Promise<string | null>;
  list(): Promise<RunSnapshot[]>;
  start(input: { mode: FixtureMode; commandId: string }): Promise<AcceptedRun>;
  startCodex(input: { projectId: string; prompt: string; commandId: string }): Promise<RunSnapshot>;
  codexResult(id: string): Promise<CodexResult>;
  startFileChange(input: { projectId: string; instructions: string }): Promise<(FileChange & { id: string }) | null>;
  approveFileChange(id: string): Promise<boolean>;
  discardFileChange(): Promise<boolean>;
  events(id: string): Promise<RunEvent[]>;
  cancel(input: { id: string; commandId: string }): Promise<RunSnapshot>;
  reconcile(): Promise<RunSnapshot[]>;
}

type CollaborationResult = Promise<CollaborationSnapshot | null>;
type CollaborationAction = (id: string, attempt: number) => CollaborationResult;

export interface CollaborationIpc {
  prepare(input: CollaborationRequest): CollaborationResult;
  status(): CollaborationResult;
  plan: CollaborationAction;
  propose: CollaborationAction;
  apply: CollaborationAction;
  review: CollaborationAction;
  revise: CollaborationAction;
  cancel: CollaborationAction;
  recordTest(input: RecordTestRequest): CollaborationResult;
  dismiss: CollaborationAction;
}

type Channels<Prefix extends string, API> = {
  [Method in keyof API & string as `${Prefix}:${Method}`]: API[Method];
};

type RuntimeChannels = Channels<'execution', ExecutionIpc> & Channels<'collaboration', CollaborationIpc>;

export type InvokeRuntime = <Channel extends keyof RuntimeChannels>(channel: Channel,
  ...args: Parameters<RuntimeChannels[Channel]>) => ReturnType<RuntimeChannels[Channel]>;

export type IpcHandlers<API> = {
  [Method in keyof API]: API[Method] extends (...args: infer Args) => Promise<infer Result>
    ? (...args: Args) => Result | Promise<Result>
    : never;
};

declare global {
  interface Window {
    organisExecution: ExecutionIpc;
    organisCollaboration: CollaborationIpc;
  }
}
