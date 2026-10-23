# Agent ACP MCP

Windows x64 및 Linux용 MCP 게이트웨이와 Windows 독립 실행형 Agent Monitor입니다. 게이트웨이는 Codex, Claude Code, Grok Build의 로그인된 CLI를 하나의 `agent_*` 도구 집합으로 연결합니다. WSL은 일반 Linux와 동일한 설치·업데이트 경로를 사용합니다. Monitor는 각 provider의 상태와 사용량을 표시하고, 서명된 GitHub 릴리스 업데이트를 확인합니다.

## 위임 에이전트 실행 속도

**2.7.2 / Gateway 2.7.1 / Monitor 1.4.1**에 포함됩니다.

Gateway 환경설정의 `CODEX_SPEED`, `CLAUDE_SPEED`, `GROK_SPEED` 기본값은 모두 `standard`입니다. 모델·reasoning effort와 독립적인 고정 설정이며, 생략해도 Standard를 요청합니다. Windows·Linux 설정 예제에 포함되어 있습니다. 지원 모델·추가 사용량·관측값 구분은 [실행 속도 설정](gateway/EXECUTION-SPEED.md)을 확인하세요.

## Linux / WSL

**2.7.1 / Gateway 2.7.0 / Monitor 1.4.0:** 상단 다운로드 아이콘 또는 **전체 업데이트**를 누르면 설치된 WSL Gateway들을 먼저, Windows Gateway·Monitor를 마지막에 업데이트합니다. 모든 대상의 작업 상태를 먼저 확인하고, 미설치 Gateway는 건너뜁니다. 중지된 배포판은 전체 업데이트 클릭 시에만 시작합니다. 개별 업데이트는 상세 영역에 유지됩니다. 별도 Linux PC는 기존 `agent-acp update`를 사용합니다.

기존 Monitor는 먼저 이번 릴리스로 업데이트해야 전체 업데이트 버튼이 생깁니다. 그 뒤부터 Windows·WSL을 한 번에 진행할 수 있습니다. [통합 업데이트 동작과 복구](distribution/UNIFIED-UPDATE.md)를 확인하세요.

배포/Gateway **2.6.0**, Monitor **1.3.0**부터 Linux 전용 서명 패키지를 제공합니다. Linux에는 Gateway와 CLI 업데이터를 설치하며 Windows Monitor나 PowerShell을 설치하지 않습니다. Linux Node.js 22.12 이상이 필요합니다. x64는 Ubuntu 20.04의 실제 Linux 실행 환경에서 검증했으며 arm64 패키지 구조는 지원하지만 실기기 검증은 하지 않았습니다.

최초 설치·기존 수동 설치의 전환은 [Linux 설치 설명](distribution/linux/README.md)을 따르세요. 전환 후 다음 명령을 사용합니다.

```sh
~/.local/bin/agent-acp status --json
~/.local/bin/agent-acp update --check
~/.local/bin/agent-acp update
~/.local/bin/agent-acp rollback
```

Windows Monitor의 업데이트 창에는 **WSL Gateway** 목록이 있습니다. WSL 없음·비활성·배포판 없음·실행/중지·Gateway 미설치를 구분합니다. 꺼진 배포판은 **시작하고 확인**을 눌러야 시작하며 Gateway를 자동 설치하지 않습니다. Linux 업데이터를 한 번 등록한 뒤 각 배포판의 업데이트를 실행할 수 있습니다. Linux 업데이트는 Monitor를 닫아도 계속되며, Windows와 Linux 설치·인증·작업 기록은 각각 보존됩니다.

## 설치

1. [Releases](https://github.com/qkrguswnd133/agent-acp-mcp/releases)에서 최신 `Agent-ACP-MCP-Windows-*.zip`과 `.sha256` 파일을 받습니다. 공개 릴리스의 `update-manifest.json`과 `update-manifest.sig`는 Monitor가 서명 검증에 사용합니다.
2. ZIP의 SHA-256을 `.sha256` 파일과 대조하고 빈 폴더에 압축을 풉니다. 압축 해제된 루트에 `Install.ps1`, `gateway/`, `monitor/`, `manifest.json`이 있어야 합니다.
3. Windows PowerShell에서 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1`을 실행합니다. Node.js **22.12 이상 x64**가 필요하며 24 LTS를 권장합니다. 기존 설치를 덮어쓰지 않습니다.
4. 설치 프로그램이 만든 `gateway\configuration`의 예제를 사용하는 MCP 클라이언트 설정에 병합합니다. [설치 및 업데이트 설명](distribution/README.md)을 확인하세요.
5. 사용하려는 Grok Build, Claude Code, Codex CLI를 각각 설치하고 자신의 subscription 계정으로 로그인합니다. 이 저장소와 릴리스에는 CLI 바이너리나 계정 정보가 들어 있지 않습니다.

`agent_status`와 `agent_models`는 CLI/프로토콜·인증·사용량·지원 정보를 확인하며 작업용 모델 프롬프트를 보내지 않습니다. 순수 로컬 패키지 검증은 릴리스에 포함된 `Verify-Package.mjs`를 사용합니다.

## 업데이트

**2.7.0 / Gateway 2.7.0 / Monitor 1.3.1:** junction 안전 검사와 명시적 링크 제거, 소유자·만료를 기록하는 정리 잠금, 백그라운드 maintenance, PID 재사용에 따른 무관 프로세스 오인 방지, 20 KiB 미만 MCP 응답, cherry-pick 대응 표시를 추가했습니다. `operation_id`는 접수이며 `agent_operation_status`로 완료를 확인합니다. Windows와 Linux/WSL에 동일한 수정이 포함됩니다. [원인·수정·검증 및 제한](gateway/MAINTENANCE-SAFETY.md)을 확인하세요.

**2.6.3 / Gateway 2.6.2 / Monitor 1.3.1:** `forget`을 파일 삭제와 분리했습니다. 경로·브랜치·Git 등록이 모두 없는 종료 작업은 PID 경고를 명시적으로 확인한 뒤 목록에서 숨길 수 있습니다. 원래 작업 상태·결과 첨부·PID 경고를 보존하며, `cleanup`의 프로세스 차단은 유지합니다.

**2.6.2 / Gateway 2.6.1 / Monitor 1.3.1:** PID 생성 시각으로 재사용을 구분합니다. 정리·forget의 PID별 근거와 전체 추적 목록 위치를 표시하며, 옛 작업별 Gradle 홈의 목록·명시적 정리 도구를 추가했습니다. 확인 불가 상태는 계속 차단하고 기존 기록과 사용자 공용 캐시는 보존합니다. [동작과 사용법](gateway/JOB-LIFECYCLE.md#process-identity-and-historical-pid-reuse)을 확인하세요.

**2.6.1 / Monitor 1.3.1:** WSL Gateway의 확인 완료 후 100% 게이지가 남는 오류를 수정했습니다. 실제 업데이트 진행 중에만 게이지를 표시합니다. Gateway는 2.6.0을 유지합니다.

**2.6.0 추가 수정:** 일부 프로세스 정리 검사 실패와 실제 잔존 PID를 구분해 정상 작업이 실패로 바뀌는 문제를 고칩니다. 정리 시에는 Parent 확인과 최신 PID·작업공간 검사를 요구합니다. 세 provider 모두 기존 Gradle 캐시를 재사용하고, 빌드 산출물은 Parent가 정리하도록 안내합니다. 기존 작업별 Gradle 폴더는 자동 삭제하지 않습니다. [상세 동작과 제한](gateway/JOB-LIFECYCLE.md)을 확인하세요.

**2.5.3 실행 종료 개선:** Claude·Grok·Codex 완료 신호를 실시간 감지하고, 종료 지연·마감·취소 시 부분 결과와 사용량을 보존합니다. MCP 대기는 최대 25초이며 연결 종료는 수락된 작업의 취소로 변환하지 않습니다. 검증·병합된 실패/취소 작업 정리와 명시적 ignored 산출물 삭제를 지원합니다. [작업 수명 및 정리](gateway/JOB-LIFECYCLE.md)를 확인하세요. Monitor는 1.2.1을 유지합니다.

**2.5.2 작업 보존 개선:** 새 worktree는 `%USERPROFILE%\.agent-acp\worktrees`에 보관합니다. 기존 TEMP worktree는 자동 이동하지 않으며, 명시적 이동·손상 복구 도구와 3일 이상 보관 경고를 제공합니다. 검증된 cherry-pick 결과의 정리는 선택적으로 patch 동등성을 확인합니다. 당시에는 리뷰 본문을 인라인으로 보존했으며, 2.7.0부터는 큰 본문도 전체 artifact로 보존하고 응답 크기를 제한합니다. Windows Codex용 portable PowerShell 7.6.6을 함께 배포하며 개인·시스템 PowerShell 설치는 변경하지 않습니다. [Worktree 및 결과 관리](gateway/MANAGED-WORKTREES.md)와 [설정 설명](distribution/README.md)을 확인하세요.

**2.3.0 모델 선택 규약 변경:** 모델·effort의 `auto`는 Parent가 작업별로 구체적인 값과 `selection_reason`을 선택해 전달하는 정책입니다. CLI 기본값으로 넘기지 않습니다. `agent_models`로 지원 정보와 고정/auto 정책을 먼저 확인하세요. 기존 고정 설정은 호출로 덮어쓰지 않습니다. MCP 재연결과 함께 [모델 선택 지침](gateway/MODEL-OVERRIDES.md) 및 [Parent 지침 템플릿](distribution/instructions/README.md)을 반영하세요. 개인 설정·지침은 자동으로 교체되지 않습니다.

Monitor에서 새 릴리스를 확인하고 현재 설치된 구성요소를 함께 업데이트할 수 있습니다. Monitor는 Ed25519 서명, 다운로드한 ZIP의 SHA-256, ZIP 내부 파일별 체크섬을 검증한 뒤 업데이트를 실행합니다. 수동 업데이트는 새 ZIP을 별도 폴더에 압축 해제한 후 `Update.ps1`을 실행합니다. 실행 중인 작업을 마치고 MCP 연결을 닫아야 할 수 있습니다. 업데이트는 이전 실행 파일의 백업과 사용자 상태를 보존합니다.

업데이트 기능이 없는 기존 사용자는 최신 ZIP의 `Update.ps1`을 한 번 실행해야 합니다. **v2.2.0 / Monitor 1.1.0도 압축 해제 오류가 있으므로 v2.2.1 ZIP의 `Update.ps1`로 한 번 업데이트하세요.** 수정된 Monitor 1.1.1부터는 `··· → 업데이트 확인`에서 변경 사항을 보고 **업데이트** 버튼 하나로 설치할 수 있습니다. 업데이트 창은 Windows 라이트·다크 테마를 따르며 배포, MCP Gateway, Monitor의 현재·최신 버전을 각각 표시합니다. 설치 영수증이 없는 기존 배포 번호는 **미확인**으로 표시합니다.

## 개발 및 릴리스

릴리스는 Windows 자산 4개와 Linux 자산 4개를 함께 게시합니다. Windows manifest 형식은 유지하며 Linux는 별도 manifest와 서명을 사용합니다. 깨끗하게 커밋한 소스에 대해 Linux에서 다음 검증을 먼저 실행합니다. WSL에서도 동일한 명령이며 `<checkout>`은 같은 소스 커밋의 Linux 절대 경로입니다.

```sh
node <checkout>/scripts/run-linux-validation.mjs --suite all --report <checkout>/build/linux-validation.json
```

검증은 별도 HOME·상태·worktree·npm 경로에서 실행합니다. 이 검증 영수증이 소스 커밋과 일치해야 아래 Windows 빌드 및 게시 검증을 통과합니다. Linux 단독 패키징은 `node distribution/linux/build-release.mjs --signing-key /absolute/private-key.pem`으로 실행할 수 있습니다. 비공개 서명 키는 저장소 밖에 둡니다.

2.5.2에서는 `agent_worktree_forget`으로 경로·브랜치·Git 등록이 모두 사라진 항목만 활성 목록에서 제외할 수 있습니다. 작업 결과와 로그는 남습니다. `interrupted` cleanup은 프로세스 검사와 Parent의 `idle_confirmed`를 요구하며, 미반영 커밋·수정 파일은 계속 보존합니다.

Gateway 테스트는 실행마다 별도 임시 저장소를 만들고 `TEMP`/`TMP`/`TMPDIR`, worktree와 상태 경로를 격리합니다. `npm test`, `npm run smoke` 및 직접 실행하는 worktree 테스트에 적용하며, 실패해도 해당 실행에서 만든 디렉터리만 정리합니다. 기존 사용자 보관 폴더는 일괄 정리하지 않습니다.

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
