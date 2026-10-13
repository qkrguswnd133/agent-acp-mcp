# Linux Gateway installation and updates

Native Linux and WSL use the same Gateway, installer, updater and state layout. Linux x64 and arm64 are accepted; Windows Monitor is optional and is not installed on Linux. Node.js **22.12 or newer** is required; Node 24 LTS is recommended. A distribution-installed Node or a user-managed Node works. The installer never runs `sudo`, changes provider CLI versions, copies authentication, or edits Codex/Claude configuration.

## First installation

Use the installer from a reviewed source checkout or a previously trusted package. Set `AGENT_ACP_NODE` when Node is not on `PATH`:

```sh
AGENT_ACP_NODE=/absolute/path/to/node sh distribution/linux/install.sh
```

This checks the latest public stable GitHub release, verifies its Ed25519-signed Linux manifest and compressed archive SHA256, validates every archive entry and internal checksum, then installs Gateway. Archives cannot contain symlinks, hard links, device files, duplicate paths or parent traversal.

Offline installation uses the same verification. Place these three release assets in one directory:

- `linux-update-manifest.json`
- `linux-update-manifest.sig`
- `Agent-ACP-MCP-Linux-VERSION.tar.gz`

```sh
sh distribution/linux/install.sh --package-dir /path/to/release-assets
```

For a downloaded release whose origin and contents you have already verified or reviewed, the archive also includes the bootstrap installer. From the directory containing the release assets, replace `VERSION` with the release version:

```sh
mkdir -p ./agent-acp-linux
tar -xzf ./Agent-ACP-MCP-Linux-VERSION.tar.gz -C ./agent-acp-linux
sh ./agent-acp-linux/linux/install.sh --package-dir "$(pwd)"
```

The bootstrap re-verifies the signed manifest, archive hash and every install path before installation. An installer extracted from an untrusted archive cannot establish its own initial trust; the reviewed source-checkout installer above remains the alternative for first installation.

The packaged [examples](examples/) contain Linux host configuration templates; replace the sample home, Node and CLI paths with your actual Linux paths. The packaged [parent instructions](instructions/) provide AGENTS/CLAUDE guidance to merge into existing global instructions. Neither is applied automatically, so existing models, authentication and project settings remain under your control.

`--install-dir /absolute/path` and `--state-dir /absolute/path` select custom locations. The default installation is `$XDG_DATA_HOME/agent-acp-mcp` or `~/.local/share/agent-acp-mcp`. The default state is `$AGENT_MCP_STATE_DIR`, `$XDG_STATE_HOME/agent-acp-mcp`, or `~/.local/state/agent-acp-mcp`. Use the exact state directory already set in the host's MCP environment when migrating. For example, an existing `AGENT_MCP_STATE_DIR=~/.local/state/agent-acp-mcp/runtime` must use that directory, not its parent.

Legacy `INSTALL/state/` and `~/.agent-acp-mcp/` records are copied only after Gateway is safely idle. Unequal destination files cause a collision error rather than replacement. The original installation, including its original state, remains in an adjacent backup. A new `agent-acp-installation.json` records the selected external state directory; Gateway uses it when no explicit environment override exists. Explicit environment overrides remain authoritative.

The updater creates `~/.local/bin/agent-acp`. Add `~/.local/bin` to your shell PATH if needed. It records the absolute Node executable, so no login shell or Windows PATH fallback is required. Reconfigure the host MCP registration to run that Linux Node with `/absolute/install/path/dist/src/index.js`; keep its provider CLI paths and authentication within Linux. Existing host settings and `AGENTS.md` are never overwritten.

## Updates and rollback

```sh
~/.local/bin/agent-acp status --json
~/.local/bin/agent-acp update --check
~/.local/bin/agent-acp update
~/.local/bin/agent-acp rollback
```

`update` updates an existing Gateway only. Distribution version is tracked separately from Gateway component version. Older installations without a receipt report distribution version as `null`, not an inferred value. A newer updater requirement or unsupported architecture produces a manual-update message. GitHub responses are cached for 15 minutes; rate-limit retry times are respected. No GitHub token or API key is needed.

Running jobs block installation. Compatible idle Gateways acknowledge a maintenance lease and shut down gracefully. Older Gateways must be disconnected from their host first. New Gateway processes starting during installation cause an abort and recovery. The updater never kills a host, provider or unrelated process. After installation, reconnect MCP in the host application.

Failures restore the old installation when possible. Backups and failure logs are retained outside the current program tree; they are never automatically deleted. Rollback between updater-aware installations preserves the current shared job history and settings and retains the replaced installation as another backup. Rollback to a legacy installation that cannot read the external state directory is blocked before replacement: it requires a reviewed manual recovery, so newly written jobs cannot disappear from view. Installation state and history are under `STATE/installations/gateway.json` and `STATE/updates/history.jsonl`.

Interrupted replacement transactions remain in `STATE/updates/transactions/`. An unfinished transaction, a failed recovery or a stale update lock blocks another installation or rollback until the saved installation paths and records have been inspected. The updater does not guess that a missing program directory means a fresh installation after a crash.

## Monitor / automation protocol

Every command accepts `--json` and emits newline-delimited JSON. Progress records have `type:"progress"`, `status:"running"`, `phase`, `progress` and `message`. The last record has `type:"result"` and `status`; failures include `error` and `blocked`. `status --json` is local-only and does not call GitHub or a provider.

For a user-requested update that survives Monitor closing:

```sh
agent-acp update --background --json
agent-acp operation OPERATION_UUID --json
```

The first command starts an independent Linux worker and returns an operation ID. The second reads the atomic operation snapshot. Worker code, logs and snapshots remain under `STATE/updates/operations/`. This is immediate execution, not scheduling. Do not infer success from the initial `started` response; wait for `installed`, `up_to_date`, `blocked`, `cancelled` or `error`.

Native Linux can use the CLI directly without WSL or Windows. Windows Monitor should discover WSL availability before offering WSL targets; absent WSL requires no configuration. Detecting a distro does not authorize starting or installing anything there. Pass distribution names and arguments as separate process arguments, never as concatenated shell commands.
