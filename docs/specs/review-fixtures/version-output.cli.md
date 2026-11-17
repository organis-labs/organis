# CLI version output contract

The CLI updater compares the subprocess stdout to an exact version string. A version label or banner breaks the installed-binary smoke check and can prevent successful updates.

- CLI-VER-7316: The entire trimmed stdout of `organis --version` must equal the bare package version character for character.
- The short form `organis -v` obeys the same rule.
