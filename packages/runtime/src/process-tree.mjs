export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// The fixed fixture owns its grandchild handle; IPC disconnect stops the
// grandchild if the direct child is killed. Never signal stored PIDs/groups.
// Unverified descendants retain workspace ownership rather than risking PID reuse.
export async function killOwnedTree({ child } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* death still needs verification */ }
}

// grandchildPid may be a number or a getter, so a pid reported after the wait started is still checked.
export async function waitForOwnedExit({ exited, grandchildPid, ready = () => true } = {}, timeoutMs = 0) {
  let childExited = false;
  exited?.then(() => { childExited = true; });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.resolve();
    const gp = typeof grandchildPid === 'function' ? grandchildPid() : grandchildPid;
    if (childExited && ready() && (!gp || !pidAlive(gp))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
