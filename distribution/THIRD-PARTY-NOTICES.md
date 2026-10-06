# Third-party notices

The monitor includes Electron 44.4.3 and Chromium/Node.js components.
Keep monitor/LICENSE and monitor/LICENSES.chromium.html with the application.
The gateway includes production npm dependencies pinned in gateway/package-lock.json,
including @agentclientprotocol/sdk, @modelcontextprotocol/client,
@modelcontextprotocol/server and zod. Their LICENSE/NOTICE files remain in node_modules.

Official Grok Build, Claude Code and Codex executables, accounts and credentials
are NOT redistributed. Users install/authenticate those products themselves.
This archive does not change the license terms of third-party components.

Portable PowerShell 7.6.6 (Windows x64) is included under gateway/runtime/powershell7.
Source: https://github.com/PowerShell/PowerShell/releases/tag/v7.6.6
PowerShell is MIT licensed; retain LICENSE.txt and ThirdPartyNotices.txt from the
official self-contained distribution, including its .NET dependency notices.
The upstream ZIP SHA-256 is pinned in scripts/powershell-runtime.json.

