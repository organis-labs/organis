# Run a local Claude and Codex collaboration

In Organis Desktop, connect your installed Claude Code and Codex using the
existing settings and their official sign-in flows. The collaboration uses the
local desktop profiles. Claude Code runs in its documented non-interactive mode
with workspace tools, MCP, project settings and session persistence disabled.
Organis does not collect provider credentials or use a shared account.
[Claude Code CLI documentation](https://code.claude.com/docs/en/headless)

Settings accepts optional Codex and Claude model IDs for the current desktop
session. A blank field uses that CLI's default model. Codex checks a selected ID
against its provider catalog before starting a turn. Claude Code must advertise
the isolation and structured-output options used by Organis before it receives
any task data. The provider still decides whether the signed-in account can use
the selected model when the task runs.

Create a named room or open a saved one, then add **Claude** and **Codex**.
Adding a participant records room membership. The provider sign-in still uses
Settings. The room and participant IDs persist in the local desktop profile.

1. Choose a registered project, describe the change and select **Plan with Claude
   + Codex**. Pick one existing UTF-8 text file directly inside the project root.
   Both versions must fit in 4 KiB.
2. Review the request and file name before sending the plan request to Claude.
   This step does not send file contents.
3. Confirm the assignment. Codex receives the brief, acceptance criteria and
   selected file contents and returns a read-only replacement. If the selected
   file changed after it was picked, start over with the current version.
4. Compare the versions and open the native approval dialog. **Apply change**
   writes only the reviewed file. Cancellation or expiry invalidates the approval.
   Approval expires ten minutes after the replacement is ready.
5. Record any tests actually run against the applied file. Enter the command,
   runner, exit code and result. Organis binds the record to the applied file's
   SHA-256 revision. User-reported evidence and the Claude verdict are displayed
   separately. This slice does not run test commands from the app.
6. Confirm the review handoff. Claude receives the plan summary and criteria,
   the file name, the before and after text, and any recorded test evidence.
   Review can pass, fail or request a revision. One user-confirmed revision is
   available and its replacement requires a fresh native approval.

The desktop panel has one active local collaboration at a time with fixed roles.
Finish or cancel it before switching rooms. Reopening a room shows its latest
saved task until you close it. The Claude stages are text-only and the Codex
stage uses the existing read-only
runtime. The handoff excludes chat history and unrelated project files. An
unrecorded test stays unrecorded even if the review passes. Arbitrary commands,
steering and queued messages are outside this slice.

Each task records attempt and stage IDs in the desktop's local profile.
**Close task** removes the saved collaboration contents from that profile.
The existing Codex run history has its own storage and is unaffected. No pending
approval survives a restart. When a process stops before a write outcome is
recorded, Organis asks the user to check the file before starting a new task.
A confirmed application can still be reviewed after an interruption.

See the [R08 collaboration contract](room-collaboration.md) for the wider design.
