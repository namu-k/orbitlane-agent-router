# OrbitLane — Codex·Claude Code·코딩 에이전트를 위한 모델 라우팅

[English](README.md)

> **상태: v0.2.0이 npm에 공개되었습니다.** `npx orbitlane`으로 설치·실행할 수 있습니다. 초기 릴리스로, Tier 1은 configuration과 audit을 제공하며 모든 runtime 경로의 enforcement를 주장하지 않습니다(Tier 2 roadmap).
>
> **v0.1.0에서 올라올 때는 재설치가 필요합니다.** report schema와 guard 인자 계약이 함께 바뀌었고, 패키지 업그레이드만으로는 이미 설치된 것이 갱신되지 않습니다. 재설치하기 전까지 해당 scope의 guard는 모든 Agent spawn을 거부하며, 어느 레이어를 재설치해야 하는지 오류에 명시합니다. [CHANGELOG.md](CHANGELOG.md) 참고.

OrbitLane은 하나의 역할-모델 라우팅 계약을 Codex/OMX와 Claude Code의 네이티브 설정으로 컴파일하고, 실제로 강제할 수 있는 범위를 감사하는 오픈소스 **라우팅 계약 컴파일러(routing contract compiler)**입니다. v1이 제공하는 것은 계약 컴파일, merge-preserving 설치, 정적 drift 감사, 그리고 Claude Code에 한정된 spawn guard입니다. 실행 시점에 모든 요청을 라우팅하는 범용 model router는 Tier 2 roadmap입니다.

OrbitLane은 LLM API 트래픽을 중계하지 않습니다. 아키텍처, 구현, 검증, 저장소 조회 같은 **에이전트 역할과 작업 분류**를 사용자가 선택한 모델 lane에 연결합니다.

## 왜 OrbitLane인가요?

코딩 에이전트 워크플로의 라우팅 규칙은 instruction 파일, agent 정의, 모델 설정, hook, 환경 변수, 워크플로 전용 prompt 등에 흩어지기 쉽습니다. 복사본은 서로 달라지고, 런타임 업데이트로 dispatch나 metadata 기능이 바뀔 수도 있습니다.

OrbitLane은 라우팅 정책을 명시적이고 이식 가능하게 만듭니다.

- judgment, implementation, bounded-retrieval lane(`sol` / `terra` / `luna`)을 한 번만 정의합니다.
- 이름 있는 역할과 작업 형태를 lane에 연결합니다.
- Codex, Claude Code 또는 둘 다 필요한 adapter만 설치합니다.
- marker 기반 병합으로 사용자가 작성한 내용을 보존합니다.
- 분류되지 않은 역할을 임의 모델에 배정하지 않고 거부합니다.
- configuration 적용과 runtime enforcement를 분리해 감사합니다.
- 지원되지 않는 capability는 성공으로 가장하지 않고 `false` 또는 `unproven`으로 보고합니다.

## 빠른 시작

package는 하나의 명령으로 CLI를 제공합니다.

```bash
npx orbitlane --help
```

아직 대화형 선택기가 없으며 설치에는 contract 경로가 필요합니다.

```text
? OrbitLane 라우팅 설정을 어디에 설치할까요?
  Codex / OMX
  Claude Code
  Both
```

CI와 dotfile 자동화를 위한 비대화형 명령은 다음과 같습니다.

```bash
npx orbitlane install --target codex --contract <path>
npx orbitlane install --target claude --contract <path>
npx orbitlane install --target both --contract <path>
```

전역 package 설치나 WSL 전용 설정은 요구하지 않습니다.

## 2-레이어 설치

OrbitLane은 두 레이어로 설치한다. 두 런타임 모두 전역과 프로젝트 instruction 파일을
병합하므로 레이어는 경쟁하지 않고 합성된다.

| 레이어 | 명령 | Claude Code | Codex |
| --- | --- | --- | --- |
| 전역 baseline | `orbitlane install --global --target both --contract <path>` | `~/.claude/CLAUDE.md`, `~/.claude/settings.json` | `~/.codex/AGENTS.md` |
| 프로젝트 authoritative | `orbitlane install --target both --contract <path>` | `CLAUDE.md`, `.claude/settings.json` | `AGENTS.md` |

`CODEX_HOME`과 `CLAUDE_CONFIG_DIR`을 설정하면 그 값을 존중한다.

설치된 모든 Claude guard는 실행 시점에 동일한 effective contract를 해석한다.
최근접 프로젝트 report가 이기고, 프로젝트 report가 없을 때만 전역 report를 쓴다.
따라서 프로젝트가 전역 baseline을 override하면서도 두 guard의 판정이 갈리지 않는다.

### install이 기록하는 것

Claude target을 설치하면 guard runtime을 그것이 읽을 report 옆인
`<config root>/.orbitlane/hook/`으로 복사하고, hook이 그 사본을 가리키게 한다.
따라서 설치한 패키지가 사라진 뒤에도 guard는 계속 판정한다. 이는 `npx`와 `dlx`의
정상적인 최종 상태다. `npx orbitlane install`은 모든 target과 두 레이어 모두에서
지원한다.

Claude target을 uninstall하면 그 사본과 snapshot 저장소를 함께 회수한다.
heartbeat 로그는 증거이므로 남긴다.

## 코딩 에이전트 모델 라우팅의 작동 방식

```text
사용자 라우팅 의도
        │
        ▼
이식 가능한 OrbitLane contract
        │
        ├──► Codex / OMX adapter ──► native agent/model 설정
        │
        └──► Claude adapter ───────► CLAUDE.md, settings, subagent 정의

        ▼
Capability probe ──► tier 결정 ──► static audit
```

Contract는 특정 skill 체계에 종속되지 않습니다. Superpowers, OMX workflow, 사용자 지시와 이후 추가되는 adapter가 동일한 역할·작업 형태 vocabulary를 사용할 수 있습니다. Skill은 **작업을 어떻게 수행할지** 설명하고, contract는 **어떤 capability lane에서 수행할지** 설명합니다.

## 이식 가능한 라우팅 contract

OrbitLane은 workflow 문장에 특정 vendor의 현재 model 이름을 고정하지 않고 semantic lane을 사용합니다.

```json
{
  "contract_version": "1.0.0",
  "lanes": {
    "sol":   { "class": "judgment",         "reasoning": "high" },
    "terra": { "class": "implementation",    "reasoning": "medium" },
    "luna":  { "class": "bounded-retrieval", "reasoning": "low" }
  },
  "roles": {
    "architect": { "lane": "sol",   "provenance": "user-approved" },
    "executor":  { "lane": "terra", "provenance": "user-approved" },
    "explore":   { "lane": "luna",  "provenance": "user-approved" }
  }
}
```

Lane은 canonical id(`sol` / `terra` / `luna`)와 `class`(judgment / implementation / bounded-retrieval) 두 층으로 표현하며, 공개 예시에는 provider model 이름을 고정하지 않습니다. Adapter는 각 lane을 contract의 선택적 per-target binding, 없으면 runtime의 공식 default(lane class 기준)로 해석하고 그 근거를 기록하며, 모호하면 추측하지 않고 실패합니다. Contract가 라우팅하는 역할은 provenance로 분류할 때까지(또는 `--strict`에서) 검증에 실패하고, 라우팅하지 않는 installed role은 `unmanaged`로 보고하며 건드리지 않습니다.

## Enforcement tier

OrbitLane은 유용한 라우팅과 runtime 증거가 필요한 주장을 분리합니다.

| Capability | Tier 1: configuration routing | Tier 2: runtime-enforced routing |
| --- | --- | --- |
| Native configuration 생성 | 가능 | 가능 |
| Semantic policy projection | 가능 | 가능 |
| 선언된 모든 역할 검증 | 가능 | 가능 |
| Configuration drift 탐지 | 가능 | 가능 |
| Typed role/model dispatch 요구 | 불필요 | 필수 |
| 지원되지 않는 모든 spawn 사전 차단 | 불가 | 필수 |
| Spawn 후 실제 role/model/reasoning 증명 | 불가 | 필수 |

Tier 1은 정상적이고 유용한 운영 모드입니다. 지원되는 native configuration을 결정적이고 감사 가능하게 만듭니다. 다만 모든 runtime 경로가 요청된 model을 사용했다고 주장하지 않습니다.

v1 Claude Code adapter는 여기에 더해 Agent tool 호출에 대한 **scoped** pre-dispatch 검사(불일치 시 deny)를 강제합니다. 이는 별도 tier가 아니라 Tier 1 내부의 한정된 capability(`claude_agent_pre_dispatch`)로 보고되며, 모든 spawn path를 포함한다고 주장하지 않습니다.

Tier 2는 대상 runtime이 다음 세 capability를 모두 증명할 때만 선택합니다.

1. Dispatch 시 typed role 또는 model input.
2. 지원되는 모든 spawn 경로를 포함하는 trusted pre-dispatch interception.
3. 실제 role, model, reasoning을 제공하는 trustworthy post-spawn metadata.

Receipt는 언제나 요청된 route를 기록할 수 있습니다. 실제 route는 runtime이 신뢰 가능한 증거를 제공할 때만 기록합니다.

## Runtime 지원

| Runtime | 계획된 adapter 상태 | 초기 enforcement 목표 |
| --- | --- | --- |
| OMX를 사용하는 Codex | v1 | Tier 1 configuration과 audit |
| Claude Code | v1 | Tier 1 configuration과 audit; capability probe 통과 시에만 더 강한 enforcement |
| OpenCode | 연구 roadmap | native agent와 category orchestration을 참고한 contract mapping |

지원 표에는 일반적인 호환성 추측이 아니라 검증된 adapter 동작만 기록합니다.

## OpenCode의 모델 라우팅이 강하게 느껴지는 이유

OpenCode의 장점은 subagent가 미리 존재한다는 사실만이 아닙니다. 이름 있는 agent가 model, mode, prompt, tools, permissions를 가진 일급 configuration object입니다. Dispatch는 이름 있는 subagent를 선택하므로 역할 identity와 model configuration이 구조화된 runtime 경계에서 만납니다. 공식 [OpenCode agents 문서](https://opencode.ai/docs/agents/)에서 확인할 수 있습니다.

그 위에 orchestration layer가 더 높은 수준의 semantic router를 만들 수 있습니다. 예를 들어 Oh My OpenAgent는 agent와 task category를 분리합니다. Orchestrator는 `quick`, `deep`, `visual-engineering` 같은 category에 위임하고 각 category는 설정된 model과 fallback chain으로 해석됩니다. 공식 repository 문서는 [orchestration model](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/orchestration.md)과 [agent/model resolution pipeline](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md)을 설명합니다.

좋은 사용감은 다음 조합에서 나옵니다.

1. 안정적인 named agent가 지속적인 행동 역할을 제공합니다.
2. Semantic category가 변하기 쉬운 provider model ID를 task prompt에서 숨깁니다.
3. 명시적인 configuration이 agent 또는 category를 model에 연결합니다.
4. Fallback chain이 사용할 수 있는 provider에 적응합니다.
5. Orchestrator는 raw model 이름이 아니라 작업의 의미를 선택합니다.

OrbitLane은 이를 보완하는 접근입니다. Vendor-neutral routing contract를 유지하고 각 runtime의 가장 강한 native surface로 컴파일합니다. OpenCode를 대체하려는 프로젝트가 아닙니다.

## Codex와 Claude adapter 설계

Codex/OMX adapter는 다음을 projection할 예정입니다.

- 역할별 model과 reasoning mapping.
- `AGENTS.md` 내부의 작은 marker 기반 policy block.
- 지원되는 generated model table과 native configuration.
- Capability 및 tier 판정 증거.
- 실제 runtime binding을 주장하지 않는 static verification.

Claude Code adapter는 다음을 projection할 예정입니다.

- `CLAUDE.md` 내부의 작은 marker 기반 policy block.
- Native `model`과 effort 설정이 포함된 custom subagent 정의.
- 기존 내용을 보존하는 settings와 지원되는 hooks.
- Configurable model과 증명된 runtime enforcement를 구분하는 capability probe.

Claude Code는 custom subagent 정의의 model 선택과 해석 순서를 [Create custom subagents](https://code.claude.com/docs/en/sub-agents)에서 공식 지원합니다. [Hooks reference](https://code.claude.com/docs/en/hooks)는 차단 가능한 event와 관찰 또는 context 주입만 가능한 lifecycle event를 구분합니다. OrbitLane은 이 native 보장 범위를 마케팅 문구로 넓히지 않습니다.

## Cross-platform 설계

OrbitLane은 platform-neutral filesystem API를 사용하는 Node.js CLI로 계획하고 있습니다.

- Linux
- macOS
- Windows
- WSL — 의존성이 아니라 지원되는 Linux 환경

Installer는 runtime convention과 명시적 flag로 사용자 configuration directory를 찾습니다. 개발자 username, home directory, shell profile 또는 특정 project path를 내장하지 않습니다.

## 개인정보 보호와 안전한 설치

OrbitLane은 로컬 configuration control을 목표로 합니다.

- Dry run으로 변경 내용을 미리 봅니다.
- 수정 전 파일을 백업합니다.
- Marker가 소유한 instruction block만 병합합니다.
- 관련 없는 사용자 instruction은 가능한 한 byte 단위로 보존합니다.
- 라우팅을 위해 prompt, credential, transcript 또는 source code를 수집하지 않습니다.
- 로컬 evidence bundle을 repository content로 게시하지 않습니다.
- 요청 모델 receipt를 실제 모델 증거로 표시하지 않습니다.

v1에는 telemetry를 넣지 않을 계획입니다.

## 자주 묻는 질문

### 코딩 에이전트 모델 라우팅이란 무엇인가요?

코딩 에이전트 모델 라우팅은 작업 역할이나 형태를 model capability lane에 연결하는 것입니다. 예를 들어 architecture는 judgment lane(`sol`), implementation은 implementation lane(`terra`), 범위가 제한된 repository lookup은 bounded-retrieval lane(`luna`)을 사용할 수 있습니다.

### Superpowers 없이도 사용자 지시로 라우팅 contract를 작동시킬 수 있나요?

네. Contract는 workflow와 독립적입니다. 사용자 instruction, native agent 정의, OMX workflow, Superpowers skill 또는 다른 adapter가 선언된 역할이나 작업 형태를 선택할 수 있습니다. Runtime adapter는 그 선택을 대상 runtime이 지원하는 가장 강한 configuration surface로 projection합니다.

### Tier 2가 아니어도 OrbitLane은 작동하나요?

네. Tier 1은 결정적인 configuration 생성, semantic policy audit, 역할 분류 검사와 drift detection을 제공합니다. 제공하지 못하는 것은 모든 spawn이 요청된 실제 model을 사용했다는 보편적인 증명입니다.

### OrbitLane은 실제 실행된 model을 보장하나요?

지원되는 모든 spawn 경로에 대해 trusted dispatch interception과 effective-model metadata를 제공하는 미래의 Tier 2 adapter에서만 보장할 수 있습니다. 그 외에는 effective model을 `unproven`으로 보고합니다.

### OrbitLane은 LLM gateway 또는 API proxy인가요?

아닙니다. OrbitLane은 코딩 에이전트 역할과 runtime adapter를 설정합니다. Model provider 사이의 network request를 중계하지 않습니다.

### OrbitLane은 WSL에 종속되나요?

아닙니다. WSL은 지원 환경 중 하나입니다. 계획된 CLI는 native Windows, macOS, Linux에서도 작동해야 합니다.

### OrbitLane이 AGENTS.md나 CLAUDE.md를 덮어쓰나요?

아닙니다. Installer는 명확히 표시된 routing block만 소유하고 주변의 사용자 content를 보존하도록 설계합니다. 모든 쓰기 전에 dry-run diff와 backup을 제공합니다.

## Roadmap

- [x] 공개 positioning과 enforcement vocabulary 정의.
- [x] Canonical contract schema와 fixture 공개.
- [x] 기존 내용을 보존하는 installer 구현.
- [x] Codex/OMX Tier 1 adapter 구현 및 검증.
- [x] Claude Code adapter 구현 및 검증.
- [x] Cross-platform integration test 추가.
- [x] npm package(`orbitlane`) 배포.
- [ ] Release artifact 서명.
- [ ] OpenCode native agent/plugin API에 대한 adapter 평가.
- [ ] 모든 capability gate를 통과한 adapter만 Tier 2로 승격.

## 프로젝트 상태

OrbitLane v0.1.0이 Tier 1 CLI로 npm에 배포되었습니다: contract 컴파일, 기존 내용을 보존하는 installer, Codex/OMX·Claude Code adapter, Claude Code scoped spawn guard. Review는 contract, claim boundary, adapter interface와 cross-platform 설치 동작에 집중해야 합니다. 모든 runtime 경로의 enforcement는 여전히 Tier 2 roadmap입니다.

## 검색 및 발견성 메모

첫 공개 release에 권장하는 GitHub topics는 다음과 같습니다.

`ai-agents`, `coding-agents`, `model-routing`, `subagents`, `codex`, `claude-code`, `opencode`, `developer-tools`, `nodejs`, `cli`

이 README는 프로젝트가 무엇을 하고 왜 유용한지, 어떻게 시작하는지를 설명하라는 GitHub 지침을 따릅니다. [About repository READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)와 [Repository topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)를 참고하세요.
