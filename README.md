# Agent ACP MCP

Windows x64용 MCP 게이트웨이와 독립 실행형 Agent Monitor입니다. 게이트웨이는 Codex, Claude Code, Grok Build의 로그인된 CLI를 하나의 `agent_*` 도구 집합으로 연결합니다. Monitor는 각 provider의 상태와 사용량을 따로 표시하고, 서명된 GitHub 릴리스 업데이트를 확인합니다.

## 설치

1. [Releases](https://github.com/qkrguswnd133/agent-acp-mcp/releases)에서 최신 `Agent-ACP-MCP-Windows-*.zip`과 `.sha256` 파일을 받습니다. 공개 릴리스의 `update-manifest.json`과 `update-manifest.sig`는 Monitor가 서명 검증에 사용합니다.
2. ZIP의 SHA-256을 `.sha256` 파일과 대조하고 빈 폴더에 압축을 풉니다. 압축 해제된 루트에 `Install.ps1`, `gateway/`, `monitor/`, `manifest.json`이 있어야 합니다.
3. Windows PowerShell에서 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1`을 실행합니다. Node.js **22.12 이상 x64**가 필요하며 24 LTS를 권장합니다. 기존 설치를 덮어쓰지 않습니다.
4. 설치 프로그램이 만든 `gateway\configuration`의 예제를 사용하는 MCP 클라이언트 설정에 병합합니다. [설치 및 업데이트 설명](distribution/README.md)을 확인하세요.
5. 사용하려는 Grok Build, Claude Code, Codex CLI를 각각 설치하고 자신의 subscription 계정으로 로그인합니다. 이 저장소와 릴리스에는 CLI 바이너리나 계정 정보가 들어 있지 않습니다.

`agent_status`와 `agent_models`는 CLI/프로토콜·인증·사용량·지원 정보를 확인하며 작업용 모델 프롬프트를 보내지 않습니다. 순수 로컬 패키지 검증은 릴리스에 포함된 `Verify-Package.mjs`를 사용합니다.

## 업데이트

**2.5.1 작업 보존 개선:** 새 worktree는 `%USERPROFILE%\.agent-acp\worktrees`에 보관합니다. 기존 TEMP worktree는 자동 이동하지 않으며, 명시적 이동·손상 복구 도구와 3일 이상 보관 경고를 제공합니다. 검증된 cherry-pick 결과의 정리는 선택적으로 patch 동등성을 확인합니다. 리뷰 본문은 64 KiB를 넘어도 그대로 반환하고 명령 로그를 줄입니다. Windows Codex용 portable PowerShell 7.6.6을 함께 배포하며 개인·시스템 PowerShell 설치는 변경하지 않습니다. [Worktree 및 결과 관리](gateway/MANAGED-WORKTREES.md)와 [설정 설명](distribution/README.md)을 확인하세요.

**2.3.0 모델 선택 규약 변경:** 모델·effort의 `auto`는 Parent가 작업별로 구체적인 값과 `selection_reason`을 선택해 전달하는 정책입니다. CLI 기본값으로 넘기지 않습니다. `agent_models`로 지원 정보와 고정/auto 정책을 먼저 확인하세요. 기존 고정 설정은 호출로 덮어쓰지 않습니다. MCP 재연결과 함께 [모델 선택 지침](gateway/MODEL-OVERRIDES.md) 및 [Parent 지침 템플릿](distribution/instructions/README.md)을 반영하세요. 개인 설정·지침은 자동으로 교체되지 않습니다.

Monitor에서 새 릴리스를 확인하고 현재 설치된 구성요소를 함께 업데이트할 수 있습니다. Monitor는 Ed25519 서명, 다운로드한 ZIP의 SHA-256, ZIP 내부 파일별 체크섬을 검증한 뒤 업데이트를 실행합니다. 수동 업데이트는 새 ZIP을 별도 폴더에 압축 해제한 후 `Update.ps1`을 실행합니다. 실행 중인 작업을 마치고 MCP 연결을 닫아야 할 수 있습니다. 업데이트는 이전 실행 파일의 백업과 사용자 상태를 보존합니다.

업데이트 기능이 없는 기존 사용자는 최신 ZIP의 `Update.ps1`을 한 번 실행해야 합니다. **v2.2.0 / Monitor 1.1.0도 압축 해제 오류가 있으므로 v2.2.1 ZIP의 `Update.ps1`로 한 번 업데이트하세요.** 수정된 Monitor 1.1.1부터는 `··· → 업데이트 확인`에서 변경 사항을 보고 **업데이트** 버튼 하나로 설치할 수 있습니다. 업데이트 창은 Windows 라이트·다크 테마를 따르며 배포, MCP Gateway, Monitor의 현재·최신 버전을 각각 표시합니다. 설치 영수증이 없는 기존 배포 번호는 **미확인**으로 표시합니다.

## 개발 및 릴리스

소스는 `gateway/`, `monitor/`, `distribution/`에 있습니다. `gateway/package-lock.json`과 `monitor/package-lock.json`으로 의존성을 고정합니다. Windows x64, Node.js 22.12+, npm 및 Windows .NET Framework C# 컴파일러가 필요합니다. 빌드는 공식 portable PowerShell ZIP의 고정 SHA-256을 검증하고, 콘솔 UTF-8 및 프로필 차단용 작은 Codex 실행기를 소스에서 컴파일합니다.

```powershell
$node = 'C:\Path\To\node.exe'
$key = Join-Path $env:USERPROFILE '.agent-acp-mcp-signing\release-ed25519-private.pem'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\distribution\Build-Release.ps1 -NodeExecutable $node -SigningKey $key
```

빌드는 깨끗한 `npm ci`에서 게이트웨이/Monitor 테스트와 컴파일, Electron 패키징, production 게이트웨이 의존성 설치를 수행합니다. 결과는 무시되는 `build/release/v<배포 버전>/`에 생성됩니다. 소스를 커밋하고 푸시한 뒤 `Publish-Release.ps1` 한 명령으로 빌드, 서명, draft 업로드, 내려받은 asset 검증, 공개까지 수행할 수 있습니다. 공개 배포 순서는 [릴리스 가이드](distribution/README.md)에 있습니다. 개인 설치 폴더, 실행 상태, credential, 서명 개인키를 패키지 입력으로 사용하지 않습니다.

## 문서

- [설치, 설정, 업데이트, 릴리스](distribution/README.md)
- [전역 지침 템플릿](distribution/instructions/README.md)
- [서드파티 고지](distribution/THIRD-PARTY-NOTICES.md)
- [모델 설정](gateway/MODEL-OVERRIDES.md) · [작업공간 동시성](gateway/WORKSPACE-CONCURRENCY.md) · [관리형 worktree](gateway/MANAGED-WORKTREES.md)

이 프로젝트의 소스와 릴리스는 provider 구독, API 키, CLI 사용 권한을 제공하지 않습니다.
