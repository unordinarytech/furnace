# Security Policy

Furnace is a local coding-agent harness. It can inspect files, edit files, and run shell commands through model-callable tools, subject to the permission model described below.

## Supported Versions

Furnace is early software. Security fixes will target the latest published minor line unless otherwise noted.

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| older versions | No |

## Reporting a Vulnerability

Please report security issues privately instead of opening a public issue.

Send a report to the repository owner through GitHub, or open a private security advisory if GitHub Security Advisories are enabled for the repository.

Include:

- Furnace version.
- Install method.
- Operating system and Node.js version.
- A minimal reproduction, if possible.
- Whether the issue requires a malicious model response, malicious repository content, user approval, or no approval.
- Any sensitive details redacted.

Do not include real API keys, private repository content, or other secrets in the report.

## Security Model

Furnace currently relies on permission gates, not an OS/container sandbox.

Default behavior:

- Read/search/question/task/todo/web tools are allowed by default.
- `write`, `edit`, `bash`, and `skill_manage` ask for user approval by default.
- `.env` and `.env.*` reads are denied by default, except `.env.example`.
- Plan mode denies most side effects except edits to the active plan artifact and safe read-only shell commands.
- Large tool outputs are bounded before model replay and full originals are stored locally under `.furnace/context-store/`.

Important limitations:

- Approved shell commands run on the host machine.
- Furnace does not currently use containers, seccomp, chroot, OS sandboxing, or VM isolation.
- File contents read by tools may enter model context and be sent to the configured model provider.
- Session data, tool outputs, image attachments, and context artifacts may be stored locally under `.furnace/`.
- Users should review permission prompts carefully, especially `bash`, broad session grants, and edits in sensitive repositories.

## Dependency and Supply Chain Notes

Furnace is distributed as an npm package and uses native dependencies, including `better-sqlite3`. Install from the official npm package and verify the package name before installing globally.

During early releases, prefer testing in non-critical repositories until you are comfortable with the permission model.
