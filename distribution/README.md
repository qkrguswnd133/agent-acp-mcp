# 설치, 업데이트, 릴리스

## 사용자 설치

Windows x64와 Node.js 22.12+ x64가 필요합니다. `Install.ps1`은 압축 해제한 릴리스 루트에서 실행합니다. 기본 위치는 `%LOCALAPPDATA%\Programs\Agent ACP MCP`와 `%LOCALAPPDATA%\Programs\Agent Monitor`이며 `-GatewayDirectory`, `-MonitorDirectory`, `-NodeExecutable`, `-NoShortcuts`로 조정할 수 있습니다. 기존 경로가 있으면 중지하고 오류를 표시합니다.

설치 프로그램은 MCP 설정 예제를 게이트웨이의 `configuration` 폴더에 생성합니다. 실제 Codex/Claude 설정과 개인의 전역 지침 파일은 자동으로 수정하지 않습니다. 해당 클라이언트의 설정에 필요한 항목만 병합하세요. 릴리스의 `examples/` 및 `instructions/` 템플릿은 시작점이고 `gateway/`의 Markdown 파일에 동작 설명이 있습니다. provider CLI와 인증은 각 사용자가 별도로 준비해야 합니다.

## 수동 업데이트

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
4. `build/release/v2.2.0/`의 ZIP, `update-manifest.json`, `update-manifest.sig`, `.sha256`을 검토합니다. ZIP 루트에 설치 파일이 바로 있으며 `manifest.json`은 자신을 제외한 모든 일반 파일을 나열합니다.
5. 소스를 커밋하고 `origin/main`에 푸시합니다. `Publish-Release.ps1 [-SigningKey <private-key-path>] [-NodeExecutable <node24.exe>] [-GhExecutable <gh.exe>]` 한 명령으로 빌드, 테스트, 서명, draft 업로드, GitHub asset 재다운로드 및 검증, 공개를 수행합니다. 스크립트는 태그가 없을 때만 만들며 기존 태그나 릴리스는 덮어쓰지 않습니다. `-DraftOnly`는 검증된 draft에서 멈추고 `-FinalizeDraft`는 같은 커밋과 원본 빌드의 provenance 및 내려받은 asset을 다시 검증한 뒤 공개합니다. 이미 테스트한 빌드를 사용하는 `-UseExistingBuild`는 `build-provenance.json`의 source commit, 테스트 통과 기록, asset hash가 모두 일치할 때만 허용됩니다.

릴리스 payload는 소스 checkout의 컴파일 결과와 npm lockfile, Electron 패키징 결과, 명시한 설치/문서 파일에서만 구성됩니다. 개인 설치, 사용자 상태, 로그, 인증 정보, 개인키, 이전 릴리스 산출물은 패키지 입력이 아닙니다. 일차 소스의 개인 경로, 사내 도메인과 credential 패턴도 빌드 전 검사합니다. 운영 환경에 영향을 주는 최종 공개 전에는 ZIP과 릴리스 설명을 사람이 검토하세요.
