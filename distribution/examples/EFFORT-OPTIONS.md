# Effort 선택 정책

Grok, Claude, Codex의 `*_EFFORT="auto"`는 Parent가 작업에 맞는 구체적인 effort를 선택해 전달하라는 정책입니다. CLI 기본값에 맡기는 동작이 아닙니다. `low`, `medium`, `high`, `xhigh`, `max`, `ultra` 등의 이름은 provider·모델·버전에 따라 일부만 지원될 수 있으므로 `agent_models`와 실제 CLI 지원 정보를 확인합니다.

- auto 필드: Parent가 구체적인 값과 `selection_reason`을 전달합니다.
- 고정 필드: 환경변수 값을 유지합니다. 다른 호출값은 오류입니다.
- 모델 auto와 effort 고정, 또는 그 반대도 지원합니다.
- 조회에서 지원 정보를 확인하지 못한 값은 미확인으로 다룹니다. 가능한 최고 effort를 추측하지 않습니다.
- 선택값과 실제 실행에서 확인한 값은 별도입니다. `unavailable`은 실제 관측값을 확인할 수 없다는 뜻입니다.

설정은 호스트의 MCP env 블록에서 수정한 뒤 재연결합니다. Codex TOML은 주석을 지원합니다. Claude의 `.json`은 유효 JSON이며 `.jsonc` 예제는 설명용이므로 주석을 제거한 후 사용하세요.

자세한 규약은 `gateway/MODEL-OVERRIDES.md`와 배포 지침을 확인합니다. API key 전환이나 provider CLI 업데이트는 필요하지 않습니다.
