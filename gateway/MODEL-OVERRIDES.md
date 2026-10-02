# 작업에 따른 Parent 모델·effort 선택

## auto와 고정 설정

2.3.0부터 Grok·Claude·Codex의 `*_MODEL` / `*_EFFORT`는 각 필드의 선택 정책입니다.

- `auto`: Parent가 작업 성격, 난이도, 도구 요구와 실제 지원 목록을 확인해 구체적인 값을 선택하고 MCP 인자로 전달합니다.
- 고정값: 설정값을 그대로 실행합니다. Parent가 다른 값을 전달하면 오류로 거절합니다. 바꾸려면 사용자가 해당 설정을 변경하고 MCP를 재연결합니다.
- 모델과 effort는 독립적입니다. 모델 auto + effort high이면 모델만 선택하고 high를 유지합니다.
- `auto`를 CLI 기본값 또는 `~/.codex/config.toml`의 기본값으로 해석하지 않습니다. 선택되지 않은 auto는 작업 실행 전에 거절합니다.

`provider="auto"`는 별개입니다. 적격 provider 중 무작위로 하나 이상의 provider를 선택하는 기존 라우팅 정책을 유지합니다.

## 호출 순서

1. `agent_status`로 실제 host·인증·quota·호출 가능 여부를 확인합니다.
2. `agent_models`로 대상 provider의 설정 정책과 모델·effort 지원 목록을 확인합니다. `provider="grok,claude,codex"`처럼 목록을 지정할 수 있습니다. 결과의 출처·확인 시각·미확인 상태를 확인하세요.
3. Parent가 auto 필드의 구체적인 값과 `selection_reason`을 작성합니다. 단순 조회에는 빠른 모델과 적은 추론, 일반 구현에는 적절한 모델과 중간 추론, 어려운 RCA·설계에는 높은 추론 역량을 고려하되 모든 작업에 최고값을 고정하지 않습니다.
4. Gateway가 고정값 충돌과 지원 여부를 검증하고 실행합니다. 실패 시 원인을 Parent에게 반환하며 다른 모델로 조용히 재실행하지 않습니다.

지원 목록이 없거나 일부만 확인되면 실제로 확인된 범위만 보고합니다. catalog 미확인을 미지원 확정으로 바꾸거나 CLI가 검증하지 않은 조합을 검증 완료로 표시하지 않습니다. CLI가 거절하면 원래 오류를 보존합니다.

## 단일 provider

다음은 Claude 목록에서 opus와 high 지원을 확인한 경우의 예입니다. 항상 현재 환경의 지원 목록을 먼저 확인합니다.

```json
{
  "provider": "claude",
  "model": "opus",
  "effort": "high",
  "selection_reason": "여러 모듈의 인증 흐름을 검토하는 작업이므로 높은 추론 수준을 선택했습니다.",
  "cwd": "C:/dev/my-project",
  "task": "인증 흐름의 변경을 읽기 전용으로 검토해줘"
}
```

고정 필드는 생략하거나 동일한 값을 전달합니다. auto 필드가 하나라도 있으면 Parent가 선택 이유를 전달해야 합니다. 구체적인 모델을 task 본문에만 적는 것은 설정이 아닙니다.

## 복수 provider와 provider auto

`provider_options.<provider>`에 `model`, `effort`, `selection_reason`을 전달합니다. top-level model/effort/selection_reason과 혼용하지 않습니다. provider_options는 라우팅 대상을 강제하지 않습니다.

`provider="auto"`에서는 선택될 수 있는 provider마다 auto 필드를 준비하세요. 여러 provider가 선택되면 작업 실행 전에 선택 정보가 모두 검증되어야 합니다. 재시도 후보에도 같은 규칙이 적용됩니다. 명시 provider 목록 밖의 provider를 임의로 추가하지 않습니다.

## 선택값과 관측값

- `selection.model` / `selection.effort`: 전달한 값, `parent` 또는 `configured` 출처, 선택 이유.
- `observation.model` / `observation.effort`: 실제 확인한 값, 확인 출처, `verified` 여부.
- 기존 루트 `model` / `effort`: 관측된 값만 유지합니다. 확인 불가는 `unavailable`입니다.
- 선택값과 실제 모델 ID가 다르면 둘 다 보존합니다. 별칭 해석 차이일 수도 있으므로 같은 값이라고 단정하지 않습니다.
- 모니터는 실제값이 없으면 선택값과 `실제 확인 불가`를 함께 표시합니다. 선택값을 실행 확인값처럼 표시하지 않습니다.
- 실패·취소에서도 확보된 선택 정보·세션·사용량·부분 결과를 보존합니다. 메타데이터 조회 실패는 본 작업 결과를 덮어쓰지 않습니다.

## 기존 호출에서 이전하기

기존 `model=auto`, `effort=auto` 호출을 그대로 보내면 선택 필요 오류가 반환될 수 있습니다. Parent 지침과 MCP 연결을 새 규약으로 갱신하고 구체적인 선택값 및 이유를 전달하세요. 고정값을 호출 인자로 덮어쓰던 동작도 거절됩니다.

새 설치 예제는 모델·effort 모두 auto입니다. 기존 개인 환경변수와 전역 지침은 설치나 업데이트로 자동 변경하지 않습니다. 예를 들어 기존 `GROK_EFFORT=xhigh`는 계속 고정값입니다.
