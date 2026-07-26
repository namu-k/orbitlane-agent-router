# OrbitLane — Codex·Claude Code·코딩 에이전트를 위한 모델 라우팅

[English](README.md)

> **상태: v0.3.0은 출시 준비가 되었고 npm 공개를 기다리고 있습니다.** 공개 후 `npx orbitlane`으로 설치·실행할 수 있습니다. 초기 릴리스로, Tier 1은 configuration과 audit을 제공하며 모든 runtime 경로의 enforcement를 주장하지 않습니다(Tier 2 roadmap).
>
> **v0.2.0에서 올라올 때 재설치는 권장 사항이며 필수는 아닙니다.** package upgrade만으로는 설치된 scope를 다시 쓰지 않고 기존 guard는 계속 올바르게 동작합니다. 새 projection instruction block이 필요할 때 각 scope를 재설치하세요. roles를 선언한 0.2 contract가 실제로 사용한 lane만 담고 있다면 재설치 전에 세 lane 모두에 binding을 추가하거나 공식 runtime default를 사용할 수 있어야 합니다. [CHANGELOG.md](CHANGELOG.md) 참고.

OrbitLane은 하나의 라우팅 contract를 Codex/OMX와 Claude Code의 네이티브 guidance로 컴파일하고, 실제로 강제할 수 있는 범위를 감사하는 오픈소스 **라우팅 계약 컴파일러(routing contract compiler)**입니다. v1이 제공하는 것은 contract 컴파일, merge-preserving 설치, 정적 drift 감사, 그리고 roles를 선언한 contract에만 적용되는 Claude Code scoped spawn guard입니다. 실행 시점에 모든 요청을 라우팅하는 범용 model router는 Tier 2 roadmap입니다.

OrbitLane은 LLM API 트래픽을 중계하지 않습니다. 아키텍처, 구현, 검증, 저장소 조회 같은 **에이전트 역할과 작업 분류**를 사용자가 선택한 모델 lane에 연결합니다.

## 왜 OrbitLane인가요?

코딩 에이전트 워크플로의 라우팅 규칙은 instruction 파일, agent 정의, 모델 설정, hook, 환경 변수, 워크플로 전용 prompt 등에 흩어지기 쉽습니다. 복사본은 서로 달라지고, 런타임 업데이트로 dispatch나 metadata 기능이 바뀔 수도 있습니다.

OrbitLane은 라우팅 정책을 명시적이고 이식 가능하게 만듭니다.

- judgment, implementation, bounded-retrieval lane(`sol` / `terra` / `luna`)을 한 번만 정의합니다.
- 이름 있는 역할과 작업 형태를 lane에 연결합니다.
- Codex, Claude Code 또는 둘 다 필요한 adapter만 설치합니다.
- marker 기반 병합으로 사용자가 작성한 내용을 보존합니다.
- 선언된 roles는 검사하며 contract에 선언되지 않은 runtime role은 unmanaged로 통과합니다.
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

프로젝트에 roles-less guidance-only Claude report를 설치하면 가장 가까운 프로젝트 report가 roles-bearing 전역 report를 가립니다. 그러면 routed spawn은 전역 guard의 검사를 받지 않고 unmanaged로 처리되어 통과합니다. 이는 scope precedence의 제한된 결과이지 보편적인 runtime enforcement가 아닙니다.

### install이 기록하는 것

모든 target은 네 줄의 instruction block을 **guidance**로 받습니다. 이 block은 해당
target의 tier-to-model binding을 담지만 enforcement는 아닙니다. Codex는 guidance만
설치합니다. guard가 없으며 `effective_model`은 `unproven`으로 보고합니다.

**Opt-in enforcement**는 contract가 `roles`를 선언할 때만 적용됩니다. 그때만 Claude
target이 guard runtime을 그것이 읽을 report 옆인 `<config root>/.orbitlane/hook/`으로
복사하고 `settings.json`에 scoped hook을 추가합니다. 이 guard는 model을 지정하지 않은
spawn에 routed model을 채워 넣고, 그 밖의 경우에는 비켜섭니다. 명시적으로 지명된 model,
구체적인 `CLAUDE_CODE_SUBAGENT_MODEL`, contract가 routing하지 않는 role은 모두 그대로
통과하며 기록만 남습니다. Model 선택을 이유로 spawn을 차단하지는 않습니다. 차단된 spawn은
실패한 턴과 재시도 비용을 발생시키므로 목적에 반하기 때문입니다. 요청을 다시 쓰는 것 역시
실제 실행 model의 보장은 아니며, `effective_model`은 계속 `unproven`입니다.
`roles`가 없는 contract는 guidance만 설치합니다. `settings.json` hook도 vendored guard
runtime도 만들지 않습니다. 설치한 package가 사라진 뒤에도 Claude guard는 계속 판정하며,
이는 `npx`와 `dlx`의 정상적인 최종 상태입니다. `npx orbitlane install`은 모든 target과
두 레이어 모두에서 지원합니다.

roles를 선언한 Claude 설치를 uninstall하면 그 사본과 snapshot 저장소를 함께
회수합니다. heartbeat 로그는 증거이므로 남깁니다.

## 코딩 에이전트 모델 라우팅의 작동 방식

```text
사용자 라우팅 의도
        │
        ▼
이식 가능한 OrbitLane contract
        │
        ├──► Codex / OMX adapter ──► AGENTS.md guidance와 생성된 report evidence
        │
        └──► Claude adapter ───────► CLAUDE.md, 생성된 report, 선택적 scoped settings hook

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
  },
  "targets": {
    "codex": {
      "lanes": {
        "sol":   { "model": "gpt-5.6-sol",   "provenance": "user-approved" },
        "terra": { "model": "gpt-5.6-terra", "provenance": "user-approved" },
        "luna":  { "model": "gpt-5.6-luna",  "provenance": "user-approved" }
      }
    },
    "claude": {
      "lanes": {
        "sol":   { "model": "opus",   "provenance": "user-approved" },
        "terra": { "model": "sonnet", "provenance": "user-approved" },
        "luna":  { "model": "haiku",  "provenance": "user-approved" }
      }
    }
  }
}
```

Lane은 canonical id(`sol` / `terra` / `luna`)와 `class`(judgment / implementation / bounded-retrieval) 두 층으로 표현합니다. 네 줄 kernel을 설치하려면 선택한 target의 세 lane(`sol`, `terra`, `luna`) 모두가 해당 target의 binding 또는 runtime의 공식 default로 해석되어야 하며, 모호하면 추측하지 않고 실패합니다. `roles`는 선택 사항입니다. 있을 때에는 각 routed role에 provenance가 필요하며, `roles`를 생략하면 의도적으로 guidance-only 설치를 선택합니다.

### Role 이름은 runtime이 쓰는 agent 식별자여야 합니다

Guard는 role 이름을 runtime이 spawn에 붙인 식별자와 그대로, 대소문자까지 구분해 대조합니다. 위 예시의 `architect`, `executor`, `explore`는 팀 형태를 서술할 뿐이며, 정확히 그 이름의 agent가 존재하기 전까지는 아무것도 routing하지 않습니다. OrbitLane은 agent 정의 파일을 설치하지 않기 때문입니다. 기본 Claude Code 세션이 이미 spawn하는 agent를 routing하려면 그 이름을 그대로 씁니다.

```json
"roles": {
  "Explore":         { "lane": "luna",  "provenance": "user-approved" },
  "general-purpose": { "lane": "terra", "provenance": "user-approved" },
  "Plan":            { "lane": "sol",   "provenance": "user-approved" }
}
```

`fixtures/contracts/claude-native-agent-roles.json`이 이 계약의 전체 형태입니다. 이것은 "전부 가장 싼 lane으로 보내기"가 아닙니다. 절감이 나오는 곳은 bounded lookup이고, 다단계 작업은 두 단계가 아니라 한 단계만 내리며, 판단은 의도적으로 비싼 lane에 남깁니다. 계약이 이름 붙이지 않은 것과 이미 model을 지정한 spawn은 건드리지 않습니다.

`sonnet`, `haiku`, `opus`에 binding된 Claude target의 설치 kernel은 정확히 다음 네 개의 영어 줄입니다.

```text
- Prefer direct work; delegate to a subagent when the delegation boundary is clear and the benefit is concrete.
- Keep judgment that needs full context, discipline, or confidentiality in the main session. A delegate that meets a new consequential judgment outside its assigned scope stops and asks the main session to decide.
- When delegating, use: execution -> sonnet, bounded lookup -> haiku, delegated verification and analysis -> opus.
- Record ROUTE_CONFLICT when parallel delegates hold overlapping write scope on the same file.
```

## Enforcement tier

OrbitLane은 유용한 라우팅과 runtime 증거가 필요한 주장을 분리합니다.

| Capability | Tier 1: configuration routing | Tier 2: runtime-enforced routing |
| --- | --- | --- |
| Native agent/model configuration 생성 | 생성된 evidence만 제공 | 가능 |
| Semantic policy projection | 가능 | 가능 |
| 선언된 모든 역할 검증 | 가능 | 가능 |
| Configuration drift 탐지 | 가능 | 가능 |
| Typed role/model dispatch 요구 | 불필요 | 필수 |
| 지원되지 않는 모든 spawn 사전 차단 | 불가 | 필수 |
| Spawn 후 실제 role/model/reasoning 증명 | 불가 | 필수 |

Tier 1은 정상적이고 유용한 운영 모드입니다. marker-bounded guidance와 생성된 audit evidence를 작성하지만, Codex native agent/model configuration이나 Claude custom subagent definition file을 설치하지는 않습니다. 또한 모든 runtime 경로가 요청된 model을 사용했다고 주장하지 않습니다.

contract가 roles를 선언하면 v1 Claude Code adapter는 Agent tool 호출에 대한 **scoped** routing pass를 추가로 적용합니다. Model을 지정하지 않은 spawn에는 routed model을 써 넣고, 그 외의 spawn은 기록한 뒤 통과시킵니다. 이는 별도 tier가 아니라 Tier 1 내부의 한정된 capability(`claude_agent_pre_dispatch`)로 보고되며, 실제 실행 model의 보장도 아니고 모든 spawn path를 포함한다는 주장도 아닙니다.

Routing은 Agent tool이 받아들이는 model만 채울 수 있습니다. 그 집합 밖의 token — 예를 들어 고정된 전체 model 식별자 — 에 bind된 lane은 guidance로는 계속 projection되지만, guard는 runtime이 거부할 호출로 다시 쓰는 대신 그런 spawn을 건드리지 않습니다. 생성된 report는 각 route에 `injectable`을 표시하므로 설치 시점에 확인할 수 있습니다. 고정 식별자를 alias로 매핑하는 것은 의도적으로 하지 않습니다. Alias는 그 시점에 가리키는 model로 해석되기 때문입니다.

Tier 2는 대상 runtime이 다음 세 capability를 모두 증명할 때만 선택합니다.

1. Dispatch 시 typed role 또는 model input.
2. 지원되는 모든 spawn 경로를 포함하는 trusted pre-dispatch interception.
3. 실제 role, model, reasoning을 제공하는 trustworthy post-spawn metadata.

Receipt는 언제나 요청된 route를 기록할 수 있습니다. 실제 route는 runtime이 신뢰 가능한 증거를 제공할 때만 기록합니다.

## Runtime 지원

| Runtime | 계획된 adapter 상태 | 초기 enforcement 목표 |
| --- | --- | --- |
| OMX를 사용하는 Codex | v1 | Tier 1 guidance와 생성된 audit evidence; native agent/model configuration을 설치하지 않음 |
| Claude Code | v1 | Tier 1 guidance와 생성된 audit evidence; 선언된 roles는 custom subagent definition 설치가 아닌 scoped request-consistency hook을 opt in |
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

Codex/OMX adapter는 다음을 projection합니다.

- `AGENTS.md` 내부의 네 줄 marker 기반 guidance block.
- 생성된 guidance-only report와 static audit evidence. Codex native agent/model configuration은 설치하지 않으며 `effective_model`은 `unproven`으로 남습니다.

Claude Code adapter는 다음을 projection합니다.

- `CLAUDE.md` 내부의 같은 네 줄 marker 기반 guidance block.
- 생성된 report. 그 안의 subagent 모양 항목은 요청 route evidence이며 설치된 Claude custom subagent definition file이 아닙니다.
- `roles`가 선언된 경우에만 기존 내용을 보존하는 settings와, model을 지정하지 않은 spawn을 lane model로 routing하는 scoped guard를 추가하며, 이는 실제 실행 model의 보장이 아닙니다.

Claude Code는 custom subagent 정의의 model 선택과 해석 순서를 [Create custom subagents](https://code.claude.com/docs/en/sub-agents)에서 공식 지원합니다. OrbitLane 0.3.0은 그 파일을 설치하지 않습니다. [Hooks reference](https://code.claude.com/docs/en/hooks)는 차단 가능한 event와 관찰 또는 context 주입만 가능한 lifecycle event를 구분하며 OrbitLane의 scoped check도 그 경계를 넘지 않습니다.

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

네. Contract는 workflow와 독립적입니다. 사용자 instruction, native agent 정의, OMX workflow, Superpowers skill 또는 다른 adapter가 선언된 역할이나 작업 형태를 선택할 수 있습니다. 모든 contract는 guidance를 projection하며, `roles` 선언은 Claude target의 scoped request-consistency check를 추가로 opt in합니다.

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

OrbitLane v0.3.0은 npm 공개를 기다리는 출시 준비 상태입니다: contract 컴파일, 기존 내용을 보존하는 installer, Codex/OMX·Claude Code의 target-specific 네 줄 guidance, model을 지정하지 않은 spawn을 대상으로 하는 opt-in Claude Code scoped routing guard를 포함합니다. Guard는 실제 실행 model을 증명하지 않으며 `effective_model`은 계속 `unproven`입니다. 모든 runtime 경로의 enforcement는 여전히 Tier 2 roadmap입니다.

## 검색 및 발견성 메모

첫 공개 release에 권장하는 GitHub topics는 다음과 같습니다.

`ai-agents`, `coding-agents`, `model-routing`, `subagents`, `codex`, `claude-code`, `opencode`, `developer-tools`, `nodejs`, `cli`

이 README는 프로젝트가 무엇을 하고 왜 유용한지, 어떻게 시작하는지를 설명하라는 GitHub 지침을 따릅니다. [About repository READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)와 [Repository topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)를 참고하세요.
