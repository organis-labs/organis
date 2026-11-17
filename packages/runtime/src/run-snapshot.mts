import type { RunSnapshot } from './execution-types.mjs';

interface RunRow {
  id: string;
  task_id: string;
  attempt_id: string;
  room_id: string;
  participant_id: string;
  command_id: string;
  workspace: string;
  mode: RunSnapshot['mode'];
  duration_ms: number;
  scope: RunSnapshot['scope'];
  state: RunSnapshot['state'];
  approval_state: RunSnapshot['approvalState'];
  owner_id: string;
  coordinator_pid: number;
  process_pid: number | null;
  exit_code: number | null;
  error_code: string | null;
  ownership_retained: number;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export function toRunSnapshot(row: RunRow): RunSnapshot {
  return {
    id: row.id, taskId: row.task_id, attemptId: row.attempt_id, roomId: row.room_id,
    participantId: row.participant_id, commandId: row.command_id, workspace: row.workspace, mode: row.mode,
    durationMs: row.duration_ms, scope: row.scope, state: row.state, approvalState: row.approval_state,
    ownerId: row.owner_id, coordinatorPid: row.coordinator_pid, processPid: row.process_pid,
    exitCode: row.exit_code, errorCode: row.error_code, ownershipRetained: Boolean(row.ownership_retained),
    cancelRequestedAt: row.cancel_requested_at, createdAt: row.created_at, updatedAt: row.updated_at,
    startedAt: row.started_at, endedAt: row.ended_at
  };
}
