# Shared runtime status contract

The `stage` field returned by `getStatus()` is a stable wire identifier for status consumers such as the CLI JSON output.

- SHARED-STATUS-8429: Every `getStatus()` response must preserve the exact wire stage identifier `local-execution-foundation`.
- Changing the identifier breaks consumers that match the documented value.
