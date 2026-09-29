# 설정 파일에 저장하는 self-provider 기본값

현재 host와 같은 provider도 별도 CLI/ACP 세션으로 호출하려면 MCP 서버의 env에 `ALLOW_SELF_PROVIDER`를 문자열 `"true"`로 지정합니다. `"false"` 또는 미설정은 기본 차단입니다. 변경 후 MCP를 재연결하세요. 같은 provider의 구독 사용량을 공유하며, 현재 앱의 모델/effort는 변경하지 않습니다.

Codex `config.toml` — 기존 env 테이블 안에 추가합니다. 동일 테이블을 중복 생성하지 마세요.

```toml
[mcp_servers.agent.env]
ALLOW_SELF_PROVIDER = "false" # 같은 provider도 허용하려면 "true"
```

Claude `claude_desktop_config.json` — 기존 서버의 env에 다른 항목과 함께 추가합니다.

```json
{
  "mcpServers": {
    "agent": {
      "env": {
        "ALLOW_SELF_PROVIDER": "false"
      }
    }
  }
}
```

위 JSON은 삽입 위치만 보여주는 조각입니다. 기존 command, args, 다른 env 항목을 유지하세요. env 값은 JSON boolean false가 아니라 문자열 "false"/"true"입니다.

우선순위: 호출의 `allow_self_provider` boolean 명시값 → env의 `ALLOW_SELF_PROVIDER` → false. 호출 값을 생략해야 설정 파일 기본값을 따릅니다. `agent_status`에도 같은 우선순위를 적용하며 결과에 적용 값과 출처를 표시합니다. `provider="codex"`처럼 명시 호출뿐 아니라 auto에도 적용됩니다. `provider="auto"`도 적용 값이 true이면 현재 host를 후보에 포함하고, false이면 제외합니다. auto는 적격 후보의 무작위 부분집합을 선택하므로 true가 현재 host의 매번 실행을 보장하지는 않습니다.

인증·quota·작업 공간 잠금·unknown host 차단과 현재 host CLI 업데이트 차단은 그대로 유지합니다. 자식 CLI/ACP에는 AGENT_ACP_MCP_DELEGATED=1을 전달하여 일반적인 gateway 재귀 호출을 차단합니다. Claude는 빈 MCP 설정, Codex는 사용자 설정 무시/빈 MCP/플러그인 비활성 옵션을 사용합니다. 이 표식은 고의로 환경을 바꾸는 스크립트에 대한 OS sandbox가 아닙니다.

