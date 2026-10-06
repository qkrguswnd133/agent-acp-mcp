# 설치, 업데이트, 릴리스

## 사용자 설치

Windows x64와 Node.js 22.12+ x64가 필요합니다. `Install.ps1`은 압축 해제한 릴리스 루트에서 실행합니다. 기본 위치는 `%LOCALAPPDATA%\Programs\Agent ACP MCP`와 `%LOCALAPPDATA%\Programs\Agent Monitor`이며 `-GatewayDirectory`, `-MonitorDirectory`, `-NodeExecutable`, `-NoShortcuts`로 조정할 수 있습니다. 기존 경로가 있으면 중지하고 오류를 표시합니다.

Node.js가 없으면 PowerShell에서 다음을 실행하고 터미널을 다시 엽니다. 설치 후 `node --version`으로 22.12 이상인지 확인하세요.

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget
node --version
```

설치 프로그램은 MCP 설정 예제를 게이트웨이의 `configuration` 폴더에 생성합니다. 실제 Codex/Claude 설정과 개인의 전역 지침 파일은 자동으로 수정하지 않습니다. 해당 클라이언트의 설정에 필요한 항목만 병합하세요. 릴리스의 `examples/` 및 `instructions/` 템플릿은 시작점이고 `gateway/`의 Markdown 파일에 동작 설명이 있습니다. provider CLI와 인증은 각 사용자가 별도로 준비해야 합니다.

### Claude·Grok·Codex와 WSL 작업 폴더

Windows Gateway에서 WSL 파일을 사용할 때는 `\\wsl.localhost\<배포판>\...` 같은 UNC 작업 경로를 전달합니다. 실행 환경은 각 provider의 Windows CLI이며, 작업 경로는 세션 기록과 프로젝트 집계에도 사용됩니다.

Gateway 2.2.2부터 지원되는 공식 Claude·Grok·Codex npm 패키지의 진입점을 확인해 `.cmd` 래퍼 없이 실행합니다. 패키지에 포함된 `.exe`는 직접 실행하고, JavaScript 진입점은 지원되는 Node.js로 실행합니다. 기존 네이티브 설치와 `CLAUDE_CLI`, `GROK_CLI`, `CODEX_CLI` 설정도 사용할 수 있으며 사용자 홈 이름을 고정할 필요가 없습니다.

직접 실행할 진입점을 확인할 수 없는 사용자 정의 `.cmd`/`.bat`는 UNC 작업 경로에서 실행 전에 중단됩니다. 해당 provider의 네이티브 실행 파일을 CLI 환경변수로 지정하거나 공식 npm 설치를 확인하세요. Gateway가 CLI를 자동 설치하거나 권한 모드를 완화하지는 않습니다. 이 처리는 Windows CLI의 작업 경로를 보존하는 것이며, Linux 전용 도구를 Windows에서 실행 가능하게 바꾸지는 않습니다. UNC 경로에서 테스트용 배치 파일을 실행하는 경우에도 같은 제한이 적용됩니다.

### Windows Codex 작업 권한

Gateway는 사용자 CLI 설정을 분리하면서 Windows 샌드박스 구현을 명시합니다. 기본 `CODEX_WINDOWS_SANDBOX="unelevated"`는 별도 관리자 설정 없이 사용할 수 있는 Windows 제한 토큰 샌드박스입니다. 이미 관리자 샌드박스 구성이 끝난 PC는 MCP 서버 env에서 `"elevated"`로 지정할 수 있습니다. 다른 값은 실행 전에 거절합니다.

구현 작업은 기본 `workspace-write`이며 MCP 서버 env의 `CODEX_IMPLEMENT_SANDBOX="danger-full-access"`로 전체 파일 시스템 접근을 허용할 수 있습니다. 이 경우 `allowed_paths`는 OS가 강제하는 경계가 아니라 작업 지침입니다. `read-only` 값도 지원합니다. 읽기 도구는 이 설정과 무관하게 `read-only`를 사용합니다. 승인·명령 정책 우회 옵션은 추가하지 않습니다. CLI 0.159.2에서는 `--ignore-user-config`로 `windows.sandbox`가 빠지면 `workspace-write`를 전달해도 파일 수정이 읽기 전용으로 거절되는 사례를 재현했습니다. 별도 정책·회사 관리 설정에 의한 거절은 이 설정으로 해제되지 않습니다.

2.5.0은 공식 Windows x64 portable PowerShell 7.6.6을 Gateway와 함께 배포합니다. 다운로드 주소와 SHA-256은 저장소의 `scripts/powershell-runtime.json`에 고정하며 빌드에서 검증합니다. 이 실행 파일은 Gateway 전용으로 사용하고 개인·시스템 PowerShell 설치나 시스템 PATH를 변경하지 않습니다. ZIP 크기는 이 런타임을 포함하므로 늘어납니다.

Codex용 별도 실행기(`runtime/codex-shell/pwsh.exe`)가 명령 콘솔을 UTF-8로 설정한 뒤 원본 PowerShell을 `-NoProfile`로 시작합니다. Windows 제한 언어 모드에서 출력 인코딩 속성 설정이 거절돼 한글이 깨지는 경우를 처리하며, 제한 토큰과 파일 접근 정책은 그대로 상속합니다. 원본 Microsoft 실행 파일은 수정하지 않습니다. 소스 빌드에는 Windows의 .NET Framework C# 컴파일러가 필요하며, 배포 ZIP 사용자는 컴파일할 필요가 없습니다.

Windows Codex는 `WindowsApps` 밖의 실제 PowerShell 7 실행 파일을 사용합니다. 기본으로 포함된 런타임을 사용할 수 있으며, 별도 실행 파일이 필요한 경우 MCP 서버 env에 `CODEX_POWERSHELL_PATH`의 절대 경로를 지정하세요. 명시한 경로가 없거나 PowerShell 7 미만이거나 Store 경로라면 실행을 거절합니다. Windows PowerShell 5.1로 대체 실행하지 않습니다. 샌드박스 자식 프로세스 PATH에서는 `WindowsApps`를 제외합니다. `shellExecution`에는 셸 선택과 관측된 시작 실패가 기록되며, 복구되지 않은 `CreateProcessAsUserW failed: 5`는 `shell_launch_failed`로 반환합니다. 부분 응답·세션·사용량은 보존합니다.

설치 후 MCP를 재연결하고 실제 작업 경로에서 읽기 전용 `git show`·`git diff` 호출을 확인하세요. PowerShell 7 제공만으로 모든 Unicode 경로나 Windows 샌드박스 정책의 실행 성공을 보장하지는 않습니다.

### Worktree 저장 위치와 유지 관리

2.5.1부터 새 worktree의 기본 루트는 `%USERPROFILE%\.agent-acp\worktrees`입니다. 패키지 앱의 AppData 가상화를 피하도록 AppData 밖을 사용합니다. `AGENT_MCP_WORKTREE_DIR`에 절대 경로를 지정하면 해당 설정이 우선합니다. `WORKTREE_STORAGE_REDIRECTED` 오류가 나면 일반 사용자 폴더의 실제 경로로 지정하고 MCP를 재연결하세요. 기존 TEMP·AppData worktree는 업데이트나 환경변수 변경만으로 이동하지 않습니다. 작업이 끝나고 원본·격리 작업공간이 유휴 상태일 때 `agent_worktree_migrate(job_id, dry_run=true)`로 확인한 뒤 `dry_run=false`로 적용합니다. `target_root`는 선택 사항이며 생략하면 현재 저장 루트를 사용합니다. 이동 후 provider 세션은 새 cwd에서 다시 시작해야 하며 기존 세션 기록의 경로를 고쳐 쓰지 않습니다.

Windows에서 소유 프로세스가 사라진 `interrupted` 작업은 미리보기의 프로세스 검사를 통과하고 Parent가 잔존 작업 여부를 확인한 뒤 `idle_confirmed=true`, `verification_summary`를 지정해 이동·복구할 수 있습니다. 이 확인값은 실제 소유자·하위 프로세스·작업 경로 검사 실패를 우회하지 않습니다. 일반 cleanup은 계속 별도 안전 조건을 적용합니다. 상세 조건과 복구 동작은 [관리형 worktree 설명](gateway/MANAGED-WORKTREES.md)을 확인하세요.

`agent_worktree_list`의 `include_disk_size`는 기본 `false`입니다. 용량이 필요할 때만 `true`로 조회하며, 최대 4개씩 검사합니다. 3일 이상 보관된 항목은 상태 경고에 나타납니다. TEMP 정리 일정은 PC 정책에 따라 달라지므로 이 경고를 안전한 보관 기한으로 해석하지 마세요. 손상 상태 확인, 복구와 patch 동등성 정리 절차는 [관리형 worktree 설명](../gateway/MANAGED-WORKTREES.md)을 따르세요.

### Codex 실행 모델·effort 기록

Codex 결과는 CLI JSON의 실행 정보를 우선 사용하고, 값이 없으면 해당 `thread_id`와 작업 경로·실행 시간이 일치하는 공식 세션 JSONL의 `turn_context`에서 보완합니다. `modelSource`와 `effortSource`는 `cli_json`, `session_jsonl`, `unavailable` 중 하나입니다. 실행 기록에 나타난 값이며 서버 내부 라우팅까지 확인한 의미는 아닙니다. 요청한 모델이나 기본값을 실제 실행값으로 대신 반환하지 않습니다.

이를 위해 Codex 호출은 `--ephemeral` 없이 실행되어 `%CODEX_HOME%\sessions`(미설정 시 `%USERPROFILE%\.codex\sessions`)에 CLI의 표준 세션 기록이 남습니다. 기록에는 대화·도구 내용이 포함될 수 있습니다. Gateway는 반환된 세션 ID에 해당하는 파일에서 모델·effort 메타데이터만 보완하며, 기록 조회 실패가 작업 결과를 바꾸지는 않습니다. 과거 ephemeral 호출의 누락 값은 소급 복원할 수 없습니다.

### Monitor 자동 실행

설치된 Monitor의 상단 `···` 또는 트레이 오른쪽 클릭 메뉴에서 **Windows 로그인 시 자동 실행**을 켜고 끌 수 있습니다. 기본으로 등록하지 않으며 사용자가 켤 때만 현재 실행 파일과 사용자 지정 데이터 경로를 등록합니다. Windows 시작 앱에서 비활성화했다면 메뉴에도 꺼짐으로 표시합니다. 개발 실행과 테스트에서는 실제 자동 실행을 등록하지 않습니다.

## 수동 업데이트

**2.3.0 이전 후 호출 변경:** `auto` 모델·effort는 Parent가 작업에 따라 선택해야 합니다. MCP를 재연결해 `agent_models`와 새 입력 설명을 불러오고, `instructions/` 템플릿의 Parent 선택 규칙을 현재 에이전트 지침에 병합하세요. 단일 provider는 `model`, `effort`, `selection_reason`, 복수/auto 라우팅은 `provider_options.<provider>`를 사용합니다. 고정 환경설정과 충돌하는 값이나 미해결 auto는 실행 전에 거절됩니다. 모니터는 선택값과 실제 확인값을 구분합니다.

**2.5.0 작업 관리:** MCP 재연결 후 worktree 이동·복구 도구와 새 입력 설명을 불러오세요. 기존 worktree는 자동 이동하거나 일괄 삭제하지 않습니다. 리뷰 본문인 `result.text`와 `result.results[*].text`는 항상 전체를 반환합니다. 명령 출력·rawEvents 등은 줄이고 원본은 `state/jobs`의 artifact에 보존합니다. 응답의 기본 예산은 64 KiB이며 본문 보존으로 초과하면 `payload.responseLimitExceededByReview=true`와 본문 바이트 수를 표시합니다. `verbose=true`는 원본 로그까지 복원합니다. 호출 앱 자체의 출력 제한은 별도로 적용될 수 있습니다. 안전 조건을 만족하는 `cleanEmpty` worktree만 완료·실패·취소 후 자동 정리됩니다.

**v2.2.0 / Monitor 1.1.0 사용자:** Electron의 `app.asar` 압축 해제 오류 때문에 앱 내 업데이트가 설치 준비 중 멈출 수 있습니다. 이번 v2.2.1 ZIP의 `Update.ps1`을 한 번 실행하세요. Monitor 1.1.1에서 해당 오류를 수정했습니다.

업데이트 기능이 없는 기존 사용자는 최신 ZIP으로 아래 명령을 한 번 실행합니다. 이후 배포부터 Monitor의 `··· → 업데이트 확인` 또는 트레이 메뉴에서 설치할 수 있습니다. 자동 확인은 시작 시와 6시간마다 수행합니다. 창에서 **업데이트**를 누르면 다운로드, 검증, 설치, 모니터 재실행까지 이어집니다. 설치 시작 전에는 취소할 수 있으며, 조회만으로 다운로드나 설치를 시작하지 않습니다. 앱에서는 이미 설치된 구성요소만 업데이트합니다.

업데이트 창의 **설치된 버전**에서 MCP Gateway, Monitor, 배포 묶음 버전을 구분해 확인합니다. 기존 설치에 영수증이 없으면 배포 번호는 미확인으로 표시합니다. Gateway를 교체한 뒤에는 MCP 클라이언트에서 연결을 다시 시작하세요.

새 릴리스 ZIP을 설치 폴더 밖의 빈 폴더에 풉니다. 해당 폴더에서 다음을 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Update.ps1 -Component All
```

`-Component Gateway` 또는 `-Component Monitor`로 한쪽만 선택할 수 있습니다. `-WhatIf`는 변경 계획을 확인하고, `-NoAutoClose`는 연결된 실행 프로세스가 있으면 종료하지 않고 중단합니다. 업데이트 스크립트는 압축 해제된 패키지의 모든 파일 체크섬을 확인한 뒤 백업 및 교체를 수행합니다. 진행 중인 provider 작업이 있으면 작업 완료 또는 취소 후 다시 시도하세요. `Run-Update.ps1`은 Monitor의 검증된 업데이트 요청을 처리하는 내부 실행기입니다.

Monitor의 자동 업데이트는 공개 GitHub 릴리스의 Ed25519 서명된 manifest, ZIP 길이와 SHA-256, 압축 내부의 `manifest.json`을 순서대로 검증합니다. 서명 검증에 쓰는 공개키는 Monitor에 포함됩니다. 개인키는 릴리스에 포함되지 않습니다.

## 개발자 릴리스 절차

1. 루트 `package.json`의 릴리스 버전과 `gateway/package.json`, `monitor/package.json`의 구성요소 버전을 확인합니다. 두 lockfile도 동기화하고 `release-notes/<릴리스 버전>.json`에 두 구성요소의 변경 사항을 작성합니다. 이 파일은 서명된 update manifest와 GitHub 릴리스 설명에 공통으로 쓰입니다.
2. 최초 1회 `Generate-SigningKey.ps1`로 Ed25519 키 쌍을 만듭니다. 개인키 기본 위치는 저장소 밖의 `%USERPROFILE%\.agent-acp-mcp-signing\release-ed25519-private.pem`입니다. `monitor/update/trusted-key.pem` 공개키를 Git에 포함합니다. 기존 개인키는 백업하고 재생성하지 마세요. 키를 바꾸면 이미 배포된 Monitor의 업데이트 신뢰 경로도 바뀝니다.
3. `Build-Release.ps1 -SigningKey <private-key-path> [-NodeExecutable <node24.exe>]`을 실행합니다. 기본으로 `npm ci`, 게이트웨이/Monitor/release 테스트, PowerShell updater fixture, Electron smoke, Electron 패키징, production 의존성 설치, MCP handshake, 서명된 실제 번들의 격리된 Windows 업데이트 smoke를 수행합니다. 같은 소스 리비전에서 테스트가 끝난 재빌드에만 명시적 `-SkipTests`를 사용합니다. 이 옵션의 결과는 공개 publisher가 요구하는 테스트 통과 provenance를 만들지 않습니다. 일정한 manifest 바이트가 필요하면 `-PublishedAt 2026-09-29T00:00:00.000Z`를 지정합니다.
4. `build/release/v<배포 버전>/`의 ZIP, `update-manifest.json`, `update-manifest.sig`, `.sha256`을 검토합니다. ZIP 루트에 설치 파일이 바로 있으며 `manifest.json`은 자신을 제외한 모든 일반 파일을 나열합니다.
5. 소스를 커밋하고 `origin/main`에 푸시합니다. `Publish-Release.ps1 [-SigningKey <private-key-path>] [-NodeExecutable <node24.exe>] [-GhExecutable <gh.exe>]` 한 명령으로 빌드, 테스트, 서명, draft 업로드, GitHub asset 재다운로드 및 검증, 공개를 수행합니다. 스크립트는 태그가 없을 때만 만들며 기존 태그나 릴리스는 덮어쓰지 않습니다. `-DraftOnly`는 검증된 draft에서 멈추고 `-FinalizeDraft`는 같은 커밋과 원본 빌드의 provenance 및 내려받은 asset을 다시 검증한 뒤 공개합니다. 이미 테스트한 빌드를 사용하는 `-UseExistingBuild`는 `build-provenance.json`의 source commit, 테스트 통과 기록, asset hash가 모두 일치할 때만 허용됩니다.

릴리스 payload는 소스 checkout의 컴파일 결과와 npm lockfile, Electron 패키징 결과, 명시한 설치/문서 파일에서만 구성됩니다. 개인 설치, 사용자 상태, 로그, 인증 정보, 개인키, 이전 릴리스 산출물은 패키지 입력이 아닙니다. 일차 소스의 개인 경로, 사내 도메인과 credential 패턴도 빌드 전 검사합니다. 운영 환경에 영향을 주는 최종 공개 전에는 ZIP과 릴리스 설명을 사람이 검토하세요.
