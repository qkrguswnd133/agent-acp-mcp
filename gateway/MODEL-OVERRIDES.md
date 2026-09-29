# 호출별 모델·effort 지정

사용자가 원하는 모델·effort를 요청하면 parent가 작업 설명에만 쓰지 말고 MCP 호출 인자로 전달합니다. 설정 파일의 *_MODEL / *_EFFORT를 auto로 유지해도 호출값이 우선합니다. `agent_ask`, `agent_review`, `agent_investigate`, `agent_implement`에 공통 적용됩니다.

우선순위는 **호출에서 지정한 필드 → 해당 provider 환경설정 → 기존 기본 정책**입니다. 모델만 지정하면 effort는 환경설정을 따릅니다. 환경변수나 다른 진행 중 작업의 설정을 변경하지 않습니다.

## provider 하나를 명시한 경우

```json
{
  "provider": "claude",
  "model": "opus",
  "effort": "high",
  "cwd": "C:/dev/my-project",
  "task": "이 저장소의 변경을 읽기 전용으로 검토해줘"
}
```

`opus`는 별칭 예시입니다. 특정 버전이 필요하면 해당 CLI/계정에서 지원되는 정확한 모델 ID를 사용합니다. 별칭은 CLI가 실제 버전으로 해석할 수 있으므로 요청한 이름과 관측 모델명이 다를 수 있습니다.

## auto 또는 여러 provider를 지정한 경우

```json
{
  "provider": "auto",
  "provider_options": {
    "claude": {"model": "opus", "effort": "high"},
    "codex": {"effort": "high"},
    "grok": {"effort": "high"}
  },
  "cwd": "C:/dev/my-project",
  "task": "변경 사항을 검토해줘"
}
```

provider_options는 모델·effort만 지정하며 provider 선택을 강제하지 않습니다. auto에서 Claude가 반드시 실행돼야 한다면 provider="claude"로 요청합니다. 명시 목록 바깥 provider의 옵션은 오류로 거절합니다. top-level model/effort는 단일 명시 provider에서만 지원하며 provider_options와 동시에 사용하지 않습니다.

## auto의 의미

- provider="auto": 호출할 provider를 적격 후보에서 무작위 선택합니다. self-provider 후보 포함 여부는 ALLOW_SELF_PROVIDER / allow_self_provider를 따릅니다.
- model="auto", effort="auto": 호출에서 명시하면 환경설정의 고정값을 덮어씁니다. Claude/Codex는 해당 CLI 인자를 생략해 CLI/모델 기본 동작을 사용합니다.
- Grok의 auto는 기존 Gateway 정책을 따릅니다. 모델은 광고된 subscription coding 모델에서 자동 선택하며 effort는 xhigh를 우선하고 미지원이면 지원되는 가장 높은 값을 선택하고 알립니다. CLI 기본값을 그대로 쓴다는 의미는 아닙니다.

## 확인과 실패 처리

- requestedModel / requestedEffort: 실행에 요청한 값.
- requestedModelSource / requestedEffortSource: call, environment, default.
- model / effort: 기존 실행 metadata로 확인된 값. 확인 불가는 unavailable입니다. Claude 별칭과 실제 snapshot ID 차이는 기존 modelEvidence 등으로 확인합니다.
- Grok은 실제 연결의 model discovery와 ACP session config를 확인합니다. 호출에서 명시한 non-auto 모델/effort가 광고되지 않으면 prompt를 보내지 않고 실패합니다. 사용자 override가 공유 health 캐시의 모델을 바꾸지 않습니다.
- Claude/Codex는 지정한 CLI 인자를 그대로 전달합니다. CLI가 미지원 조합을 거절하면 그 오류와 부분 결과를 반환하며 Gateway가 다른 모델로 다시 실행하지 않습니다. CLI 내부의 실제 선택을 확인할 수 없으면 요청값을 실제값으로 추측하지 않습니다.
- provider CLI 업데이트, API-key 전환 또는 중단된 구현 자동 재시도는 하지 않습니다.

MCP 재연결 후 새 입력 항목이 나타납니다. 환경설정을 바꿀 필요 없이 이번 호출만 지정할 수 있습니다. 실행 중인 작업을 재연결 때문에 강제 종료하지 마세요.
