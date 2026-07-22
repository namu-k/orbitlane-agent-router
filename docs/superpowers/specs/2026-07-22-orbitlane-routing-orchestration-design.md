# OrbitLane Routing and Orchestration Design

> 상태: 검토용 설계 명세
>
> 이 문서는 OrbitLane의 구현 완료를 주장하지 않는다. 현재 저장소는 공개 전 설계 단계이며, 아래 CLI, contract, adapter, capability probe와 검증 항목은 구현할 v1의 기준이다.

## 1. 문서 목적

이 문서는 OrbitLane 저장소를 만드는 이유와 사용자가 제기한 우려를 기록하고, 그 우려를 해소하기 위한 하나의 실행 설계를 정의한다.

다루는 범위는 다음과 같다.

- role, lane, model을 분리한 portable routing contract
- 불필요한 subagent 생성을 막는 direct-first delegation gate
- 긴 대화와 계획 문서를 반복 전송하지 않는 context-transfer 정책
- 큰 작업 계획을 실행할 때의 primary-owner 모델
- 미리 정의한 agent role과 작업 시점에 생성하는 agent instance의 구분
- Superpowers, OMX workflow, 사용자 지시와 routing contract의 결합 방식
- Codex/OMX와 Claude Code adapter
- Tier 1과 Tier 2의 증명 경계
- 공개 저장소, 설치 UX, 개인정보, cross-platform 요구사항
- 구현 순서와 검증 시나리오

이 문서는 설명과 설계 결정을 위한 문서다. 아직 존재하지 않는 CLI option이나 runtime guarantee를 reference-grade API로 제시하지 않는다.

## 2. OrbitLane을 만드는 목적

코딩 에이전트 환경에서는 동일한 routing 의도가 여러 곳에 중복된다.

- `AGENTS.md` 또는 `CLAUDE.md`의 자연어 정책
- native agent 또는 subagent 정의
- role별 model과 reasoning 설정
- skill과 workflow prompt
- hook과 spawn command
- runtime-specific 환경 변수

이 복사본들은 시간이 지나면서 달라진다. 모델 이름이 바뀌거나 새 role이 추가되면 일부 설정만 갱신될 수 있다. 설정에 model이 적혀 있다는 사실과 실제 spawn이 그 model을 사용했다는 사실도 서로 다르다.

OrbitLane의 목적은 다음과 같다.

1. 한 개의 authoritative contract에서 role과 semantic lane을 정의한다.
2. provider와 runtime에 맞는 실제 model identifier를 adapter가 해석한다.
3. Codex/OMX와 Claude Code에 필요한 설정만 선택적으로 projection한다.
4. skill, workflow, 사용자 지시가 같은 role vocabulary를 사용하게 한다.
5. 불필요한 delegation과 context 복제를 기본값에서 제거한다.
6. 설정 적용, 정책 감사, 실제 runtime enforcement를 구분해 보고한다.
7. 증명할 수 없는 effective model은 `unproven`으로 남긴다.

OrbitLane은 LLM API proxy나 provider gateway가 아니다. Prompt와 source code를 원격 서버로 전달해 model request를 중계하지 않는다. 로컬 coding-agent runtime의 role, workflow, configuration을 컴파일하고 감사하는 도구다.

## 3. 비목표

v1은 다음을 목표로 하지 않는다.

- 모든 요청을 별도 router model에게 보내는 semantic proxy
- 모든 작업을 multi-agent workflow로 변환하는 orchestration framework
- Superpowers나 OMX를 대체하는 skill system
- model 품질을 자동 benchmark해 provider를 임의 선택하는 서비스
- 사용자의 transcript, prompt, source code 또는 credential 수집
- capability evidence 없이 Tier 2를 선언하는 것
- WSL 전용 installer 또는 특정 사용자 home path에 의존하는 배포
- third-party skill의 내부 동작을 무조건 재작성하는 것

## 4. 사용자가 제기한 우려와 설계 응답

### 4.1 긴 context를 두 번 읽는 비용

#### 우려

현재 agent가 긴 대화와 계획을 읽은 뒤 role, lane, model을 판단하고, 같은 내용을 새 subagent에게 그대로 전달하면 전체 입력 token이 거의 한 번 더 발생한다. 별도 router model까지 전체 context를 읽으면 비용이 더 늘어난다.

#### 결정

- 별도의 router LLM이 전체 transcript를 다시 읽는 구조를 만들지 않는다.
- 명시적 role, skill, task type과 deterministic rule을 먼저 사용한다.
- 현재 leader가 이미 가진 context로 필요한 의미 판단을 수행한다.
- subagent에는 전체 transcript 대신 bounded task packet을 전달한다.
- task packet이 원래 context와 비슷한 크기가 되면 delegation하지 않는다.
- full-context 또는 fork delegation은 명시적 opt-in으로만 허용한다.
- prompt caching은 비용 최적화 수단일 뿐 architecture의 전제나 correctness 근거로 삼지 않는다.

전체 context token을 `C`, role instruction을 `R`, task packet을 `P`라고 할 때 피해야 할 구조는 다음과 같다.

```text
leader(C) + child(C + R + P) ~= 2C + R + P
```

목표 구조는 다음과 같다.

```text
leader(C) + child(P + R), where P << C
```

`P`가 `C`에 가까워지면 router는 `direct` 또는 기존 persistent owner의 `resume`을 선택한다.

### 4.2 필요 없는 subagent로 인한 context 손실

#### 우려

작은 작업이나 대화의 뉘앙스가 중요한 작업을 subagent에게 넘기면 의도, 우선순위, 금지사항이 요약 과정에서 손실될 수 있다. 전달과 재검증 비용이 실제 작업보다 커질 수도 있다.

#### 결정

OrbitLane의 기본 실행 방식은 `direct`다. Delegation은 이익이 입증되는 예외다.

다음 조건은 delegation을 막는 veto다.

- 짧고 일회성인 작업
- 사용자 의도나 우선순위 판단이 핵심인 작업
- 여러 단계가 같은 context를 계속 공유하는 작업
- 요구사항이 아직 변하고 있거나 모호한 작업
- 한정된 task packet으로 충실하게 표현할 수 없는 작업
- subagent에게 설명하는 비용이 직접 실행 비용과 비슷하거나 더 큰 작업
- shared mutable file을 두 agent가 동시에 수정해야 하는 작업
- 구조, 보안, 제품 범위를 새로 결정해야 하는 작업

다음 조건 중 하나 이상이 있고 veto가 없을 때만 delegation 후보가 된다.

- 서로 독립적인 작업을 병렬로 수행할 수 있음
- specialist role이 정확도나 안전성을 실질적으로 높임
- 테스트, 로그, diff처럼 출력량이 큰 작업을 leader context에서 격리할 가치가 있음
- 독립 검증이 구현자와 분리되어야 함
- 장시간 실행되는 검증을 별도 execution unit으로 관리할 가치가 있음

Leader는 최종 판단, 결과 통합과 사용자-facing verification을 계속 소유한다.

### 4.3 큰 작업 계획을 받으면 agent가 과도하게 늘어나는 문제

#### 우려

큰 계획 문서에 대한 실행 지시가 곧바로 task별 fresh subagent 생성으로 이어질 수 있다. 순차 의존성이 강한 계획에서는 각 agent가 계획과 이전 결과를 반복해서 읽어야 한다.

#### 결정

계획 크기만으로 delegation을 활성화하지 않는다. 결합도와 독립성을 기준으로 실행 topology를 선택한다.

```text
큰 계획 + 강한 순차 의존성
  -> 하나의 persistent primary owner

큰 계획 + 독립된 work package
  -> primary owner + 선택적 bounded specialists

큰 계획 + 새로운 consequential judgment
  -> executor 일시 정지 + read-only architect/critic 판단 + 같은 executor resume
```

Primary owner는 authoritative plan을 한 번 읽고 durable progress ledger를 유지한다. 같은 실행 흐름의 다음 phase를 위해 새 agent를 만들지 않는다. 별도 verifier는 구현 완료 후 독립 검증이 실제로 필요할 때만 사용한다.

### 4.4 기본 subagent를 미리 만들지, 매번 새로 만들지

#### 우려

모든 역할을 즉석에서 만들면 prompt와 권한이 흔들린다. 반대로 많은 agent를 미리 실행하면 비용과 context 관리 부담이 커진다.

#### 결정

역할 정의는 미리 만들고, 실행 instance는 필요할 때만 생성한다.

v1의 최소 role catalog는 다음과 같다.

| Role | 기본 권한 | Semantic lane | 책임 |
| --- | --- | --- | --- |
| `explore` | read-only | `luna` (bounded-retrieval) | 파일, symbol, 현재 상태 조회 |
| `executor` | write and test | `terra` (implementation) | 구현, 수정, refactor |
| `team-executor` | write and test | `terra` (implementation) | 승인된 team execution |
| `verifier` | read and test | `terra` (implementation) | 독립 검증과 증거 생성 |
| `test-engineer` | write and test | `terra` (implementation) | 테스트 설계, fixture와 회귀 검증 |
| `architect` | read-only | `sol` (judgment) | 구조와 consequential judgment |
| `critic` | read-only | `sol` (judgment) | 계획과 판단의 반대 검토 |

Lane 어휘는 두 층으로 고정한다. `sol`/`terra`/`luna`는 canonical lane id이고, judgment/implementation/bounded-retrieval은 §8.1 contract의 `class` 값이다. 이 두 층 외의 비공식 라벨(fast, standard 등)은 문서와 generated 출력 어디에도 사용하지 않는다.

Role prompt에는 현재 provider의 raw model identifier를 넣지 않는다. Provider adapter가 semantic lane을 installed-release model로 해석한다. Agent session은 delegation gate를 통과할 때 생성하고, 같은 task family의 후속 작업은 가능한 경우 resume한다.

위 표는 portable core catalog다. Runtime adapter는 설치된 release가 제공하는 전체 role surface를 별도로 열거해야 한다. Core catalog에 없는 installed role은 `unmanaged`로 분류해 audit 보고서에 기록하고, configuration generation은 계속 진행한다. Unmanaged role의 prompt, model, lane은 감사 범위 밖임을 보고서에 명시하며, OrbitLane은 이를 수정하거나 임의 분류하지 않는다.

Fail-closed는 라우팅 대상 role에만 적용한다. Contract가 명시적으로 참조하는 role이 미분류이거나 사용자가 `--strict` 모드를 켠 경우에만 generation이 실패한다. 실사용 환경에는 서드파티 도구가 설치한 agent가 다수 존재하므로, 미분류 installed role 전체를 실패 조건으로 삼으면 설치 자체가 불가능해진다.

### 4.5 작업 지시에 skill이 포함된 경우

#### 우려

`executing-plans` 같은 skill이 활성화되면 skill의 workflow가 router를 우회하거나, skill과 router가 각각 subagent를 만들어 중복 orchestration을 만들 수 있다.

#### 결정

Skill과 router는 경쟁하는 top-level orchestrator가 아니다.

- Skill은 작업 절차와 checkpoint를 정의한다.
- Delegation gate는 새 execution unit이 필요한지 결정한다.
- Router는 선택된 execution unit의 role, lane, model을 결정한다.
- Runtime adapter는 가능한 native surface에 이를 projection하고 증거를 기록한다.

Skill이 활성화되어도 router는 계속 작동한다. 다만 Tier 1에서는 모든 third-party spawn path를 가로챘다고 주장하지 않는다.

## 5. 핵심 설계 원칙

1. **Direct first:** 새 agent를 만드는 것이 기본값이 아니다.
2. **Work, not history:** 작업을 위임하며 대화 기록을 위임하지 않는다.
3. **One primary owner:** 결합된 multi-phase 작업에는 지속적인 책임자 한 명을 둔다.
4. **Stable roles, ephemeral instances:** role profile은 안정적으로 유지하고 session은 필요할 때만 만든다.
5. **Workflow and routing are orthogonal:** skill은 how, router는 who/which lane을 담당한다.
6. **Explicit intent wins:** 사용자가 명시한 skill과 execution topology를 암묵적 분류보다 우선한다.
7. **No silent fallback:** 명시적 요청과 capability가 충돌하면 몰래 다른 workflow나 model로 바꾸지 않는다.
8. **Evidence before claims:** requested route와 effective route를 구분한다.
9. **Fail closed on unknown routed roles:** provenance 없는 신규 role을 임의 분류하지 않는다. 라우팅이 요청된 role에 한정하며, 라우팅하지 않는 installed role은 `unmanaged`로 보고하고 설치를 막지 않는다.
10. **Local and merge-preserving:** installer는 marker-owned block만 수정하고 prompt나 source를 수집하지 않는다.

## 6. 전체 architecture

Architecture는 실행 주체가 다른 세 평면(enforcement plane)으로 구분한다. 어느 상자를 누가 실행하는지가 Tier 경계(§10)와 구현 범위(§16)를 결정한다.

```text
[Plane 1 — compile-time enforcement: OrbitLane 코드가 실행]

  User-owned contract (JSON)
        |
        v
  Contract compiler ──► Role -> lane -> model resolver
        |                        |
        +------------+-----------+
        |            |
        v            v
   Codex/OMX     Claude Code
    adapter        adapter
        |            |
        +-----+------+
              v
  Capability probe / static auditor
              |
              v
  requested-route evidence, tier decision

[Plane 2 — policy projection: 생성된 정책 텍스트를 runtime LLM이 수행]

  marker-bounded policy block (AGENTS.md / CLAUDE.md)
    - Intent and skill resolver 규칙 (§6.2)
    - Primary-owner selection 규칙 (§6.3)
    - Direct-first delegation gate 규칙 (§6.4)
    - Context packet / session 규칙 (§6.5, §6.6)
  * v1에서 이 규칙들은 runtime 코드가 아니라 projection된 텍스트다.
  * 준수 여부는 §14의 behavioral adherence eval로 측정하며,
    측정 전까지 enforcement로 주장하지 않는다.

[Plane 3 — hook enforcement: Claude Code PreToolUse spawn guard가 강제]

  Agent spawn 요청 ──► spawn guard (allow / deny) ──► heartbeat + effective evidence
  * Agent tool 호출 경로에 한정된 scoped enforcement (§9.4)
  * Codex/OMX에는 v1에서 이 평면이 없다: Tier 1 configuration + audit
```

Plane 2의 구성요소(§6.2~§6.6)는 v1에서 실행 코드로 구현하지 않는다. Contract compiler가 이 규칙들을 marker-bounded 정책 텍스트로 projection하고, §14.2 fixture는 projection된 텍스트의 기대치를 검증한다. 이 규칙을 pre-dispatch 결정 엔진 코드로 만드는 것은 runtime이 신뢰 가능한 호출 지점을 제공할 때(Tier 2 확장)로 미룬다.

### 6.1 Canonical contract compiler

Contract compiler는 user-owned JSON contract를 읽고 다음 projection을 생성한다.

- semantic lane 정의
- role별 lane과 reasoning mapping
- execution 및 context policy
- runtime adapter용 native agent configuration
- marker-bounded `AGENTS.md` 또는 `CLAUDE.md` policy block
- static verification input

Generated 파일을 authoritative source로 취급하지 않는다. Contract가 유일한 source of truth다.

### 6.2 Intent and skill resolver

Resolver는 전체 transcript를 별도 model에 보내지 않고 다음 순서를 적용한다.

1. 사용자가 명시한 role, lane, model, topology
2. `$name` 또는 runtime hook으로 증명된 explicit skill activation
3. 활성 workflow가 선언한 task type 또는 role request
4. plan metadata와 명시적 file/task boundary
5. deterministic task-shape rule
6. 필요한 경우에만 현재 leader의 semantic judgment

문서나 prompt에서 skill 이름이 단순히 언급된 것은 activation이 아니다. Activation은 explicit invocation, user-approved authoritative plan의 선언 또는 runtime이 제공하는 trustworthy hook evidence가 있어야 한다. Web page, issue body, log와 retrieved document 같은 untrusted content는 skill activation 권한을 갖지 않는다.

### 6.3 Primary-owner selector

Primary owner는 요청 전체를 책임지는 execution role이다.

- 승인된 구현 계획은 `executor` 또는 `team-executor`
- 구조·보안·분류 판단은 `architect` 또는 `critic`
- 제한된 조회는 `explore`
- 검증 전용 요청은 `verifier`

가능한 runtime에서는 전체 계획을 읽기 전에 typed role input으로 primary owner를 선택한다. 그런 pre-dispatch surface가 없는 runtime에서는 현재 leader가 최소 metadata와 명시적 task type으로 선택하며, 이 경로를 effective-model proof로 과장하지 않는다.

### 6.4 Delegation gate

Delegation gate의 개념적 판정은 다음과 같다.

```text
delegate when:
  task_is_bounded
  and context_packet_is_sufficient
  and no_delegation_veto
  and (parallelism_gain
       or specialist_gain
       or output_isolation_gain
       or independent_verification_gain)
```

계획의 line count, token count, task 수만으로는 `delegate`가 되지 않는다.

Gate는 다음 execution mode 중 하나를 반환한다.

| Mode | 의미 | 기본 사용 조건 |
| --- | --- | --- |
| `direct` | 현재 owner가 직접 수행 | 기본값, 짧거나 context-heavy한 작업 |
| `persistent-owner` | 동일 agent session을 phase 사이에 재사용 | 결합된 multi-phase 계획 |
| `bounded-delegate` | 작은 task packet으로 specialist 호출 | 독립적이고 검증 가능한 작업 |
| `resume-delegate` | 기존 child session에 delta만 전달 | 같은 bounded task의 후속 작업 |
| `full-context` | 전체/fork context 전달 | 사용자 또는 명시적 workflow의 opt-in |

### 6.5 Context packet builder

Bounded task packet의 필수 field는 다음과 같다.

```yaml
task_id: stable-task-id
role: executor
objective: 한 문장으로 표현한 작업 결과
acceptance:
  - 검증 가능한 완료 조건
constraints:
  - 변경 금지 범위
authority:
  - path: docs/plans/example.md
    sha256: authoritative-hash
write_scope:
  - src/example.ts
dependencies:
  - 이전 task가 확정한 interface 또는 artifact 경로
evidence:
  - 필요한 test, log, diff artifact 경로
report_contract:
  - status, changed files, tests, concerns
stop_conditions:
  - 새로운 구조 판단이 필요한 경우
```

다음 내용은 기본 packet에서 제외한다.

- 전체 conversation transcript
- 관련 없는 이전 task summary
- agent가 직접 읽을 수 있는 대형 diff나 log 본문
- user credential과 secret
- 이미 durable artifact에 기록된 정확한 값의 중복 복사

대형 plan, diff, log와 test report는 content를 prompt에 붙이지 않고 path와 hash로 전달한다. Child는 필요한 artifact만 읽고, 상세 결과도 report file에 쓴 뒤 짧은 status만 반환한다.

### 6.6 Session and progress manager

Session manager는 다음 규칙을 따른다.

- 같은 결합 작업에는 새 agent를 반복 생성하지 않는다.
- child가 `NEEDS_CONTEXT`를 반환하면 새 child보다 기존 session resume을 우선한다.
- phase와 task 완료 상태는 durable ledger에 저장한다.
- compaction 이후 ledger와 Git evidence로 재개한다.
- 완료된 task를 context 손실 때문에 다시 dispatch하지 않는다.
- final integration과 user report는 primary owner가 수행한다.

### 6.7 Capability probe and auditor

Auditor는 configuration과 runtime proof를 분리한다.

- Contract projection 일치
- role provenance 완전성
- installed-release model resolution
- skill integration registry와 precedence
- deterministic delegation decision fixture
- context policy와 packet schema
- adapter별 generated output
- Tier decision

Tier 2는 다음 세 항목이 모두 `true`일 때만 가능하다.

1. Typed role/model input
2. 모든 지원 spawn path를 포함하는 trusted pre-dispatch interception
3. Effective role/model/reasoning을 제공하는 trustworthy post-spawn metadata

하나라도 `false` 또는 `unproven`이면 Tier 1이다.

v1 Claude adapter는 PreToolUse spawn guard(§9.4)로 Agent tool 호출 경로에 한정된 pre-dispatch interception을 제공한다. 이는 별도 tier가 아니라 Tier 1 내부의 한정된 enforcement scope다. `role_binding_enforced`는 boolean으로 유지해 `false`로 두고, 범위 한정 enforcement는 capability 객체에 `claude_agent_pre_dispatch: { "status": "enforced", "scope": "Agent tool only" }`로 보고한다. 모든 spawn path를 포함한다고 주장하지 않으며 tier 자체는 `tier1`로 남는다.

## 7. Skill과 routing의 결합 규칙

### 7.1 우선순위

```text
1. System, safety, filesystem and authority constraints
2. Explicit user prohibitions and execution topology
3. Explicitly invoked skill or workflow
4. Skill-declared role/task request
5. Direct-first delegation gate
6. Role -> lane -> model mapping
7. Runtime capability and evidence boundary
```

낮은 우선순위는 높은 우선순위를 조용히 바꿀 수 없다.

### 7.2 Skill activation 분류

| 입력 | Activation | Router 동작 |
| --- | --- | --- |
| 사용자가 `$executing-plans` 호출 | explicit | workflow 유지, topology는 adaptive |
| 사용자가 `$subagent-driven-development` 호출 | explicit topology | subagent workflow 요청으로 처리 |
| plan에 skill 이름이 일반 문장으로 존재 | none | 이름만으로 활성화하지 않음 |
| user-approved authoritative plan이 `REQUIRED SUB-SKILL`로 명시 | plan-declared | plan hash, provenance와 capability 확인 후 활성화 |
| trusted runtime hook이 skill context 주입 | hook-proven | hook provenance 기록 후 활성화 |
| 자연어 classifier만 skill을 추정 | advisory | 자동 spawn 근거로 사용하지 않음 |

### 7.3 `executing-plans` 예시

`executing-plans`는 계획 검토, task 실행과 verification checkpoint를 정의한다. 이 skill이 활성화되어도 계획 크기만으로 fresh subagent를 만들지 않는다.

1. Plan의 authority와 hash를 확인한다.
2. Task 사이의 결합도와 독립성을 판정한다.
3. 결합된 plan이면 한 persistent executor가 실행한다.
4. 독립 task가 있고 benefit gate가 통과하면 해당 task만 bounded delegation한다.
5. 구현 후 독립 review가 가치 있을 때 verifier를 호출한다.

Skill이 subagent-capable runtime을 선호하더라도, subagent workflow의 자체 적용 조건과 상위 direct-first policy를 함께 만족해야 한다.

### 7.4 명시적 subagent workflow 예시

사용자가 `$subagent-driven-development`처럼 subagent topology 자체를 명시하면 이는 direct-first 기본값에 대한 opt-in이다. 그래도 다음 검사는 유지한다.

- task가 실제로 독립적인가
- task packet이 충분한가
- write scope가 겹치지 않는가
- runtime이 요청한 agent type과 model을 지원하는가
- 실행 결과를 primary owner가 검증할 수 있는가

명시적 topology와 plan의 실제 결합도가 충돌하면 자동으로 다른 workflow로 가장하지 않는다. `ROUTE_CONFLICT`를 기록하고 충돌을 해결해야 한다.

### 7.5 Unknown skill

알 수 없는 skill은 임의 role이나 model로 분류하지 않는다.

- Skill activation 자체는 runtime이 처리할 수 있다.
- OrbitLane은 해당 skill 때문에 추가 subagent를 만들지 않는다.
- Skill이 typed role spawn을 요청하면 알려진 role만 route한다.
- Typed interception이 없는 Tier 1에서는 universal enforcement를 `unproven`으로 남긴다.

## 8. Canonical data model

### 8.1 Static contract

아래 예시는 field 방향을 보여주는 설계안이다. 정식 JSON Schema는 구현 단계에서 별도 versioned artifact로 작성한다.

```json
{
  "contract_version": "1.0.0",
  "lanes": {
    "sol": {
      "class": "judgment",
      "reasoning": "high"
    },
    "terra": {
      "class": "implementation",
      "reasoning": "medium"
    },
    "luna": {
      "class": "bounded-retrieval",
      "reasoning": "low"
    }
  },
  "roles": {
    "architect": { "lane": "sol", "provenance": "user-approved" },
    "critic": { "lane": "sol", "provenance": "user-approved" },
    "executor": { "lane": "terra", "provenance": "user-approved" },
    "team-executor": { "lane": "terra", "provenance": "user-approved" },
    "verifier": { "lane": "terra", "provenance": "user-approved" },
    "test-engineer": { "lane": "terra", "provenance": "user-approved" },
    "explore": { "lane": "luna", "provenance": "user-approved" }
  },
  "execution_policy": {
    "default_mode": "direct",
    "coupled_plan_mode": "persistent-owner",
    "full_context": "explicit-only",
    "unknown_role": "reject",
    "unknown_skill": "no-extra-delegation"
  },
  "context_policy": {
    "default": "bounded-task-packet",
    "prefer_artifact_paths": true,
    "prefer_session_resume": true,
    "packet_budget": "adapter-measured",
    "token_savings_claim": "requires-telemetry"
  }
}
```

Provider model identifier는 public generic contract에 고정하지 않는다. 다만 "installed release에서 해석한다"만으로는 해석 함수의 입력이 정의되지 않는다. 설치된 release는 보통 복수의 모델을 제공하며, 사용자의 선호·계정 allowlist·환경 override를 표현할 자리가 필요하다. 해석 순서는 다음과 같이 고정한다.

1. Contract의 선택적 per-target binding: `targets.<adapter>.lanes.<lane>.model` (provenance 필수). 사용자 로컬 contract에만 존재하며 공개 예시에는 넣지 않는다(§13).
2. Binding이 없으면 runtime의 공식 default model과 lane `class` 매핑 규칙으로 해석하고 그 근거를 기록한다.
3. 그래도 모호하면 `AMBIGUOUS_MODEL_RESOLUTION`으로 실패한다. Adapter는 어떤 경우에도 암묵적으로 추측하지 않는다.

Lane의 `reasoning` field는 의도 선언이며, projection 가능 여부는 adapter capability matrix가 결정한다. Codex/OMX는 per-agent reasoning 설정으로 실제 projection하고 증거를 기록한다. Claude Code는 subagent frontmatter의 `effort`(`low|medium|high|xhigh|max`)로 reasoning effort를 projection할 수 있으므로 `reasoning.effort: supported`로 보고한다. 다만 per-subagent extended-thinking toggle은 없고 subagent가 세션 thinking 설정을 상속하므로 `reasoning.thinking: session-inherited`로 명시한다. 두 경우 모두 effective reasoning을 증명할 metadata가 없으면 `reasoning.effective: unproven`으로 남기고, 이 항목을 근거로 tier를 승격하지 않는다. Runtime이 per-subagent thinking surface를 추가하면 capability probe가 자동으로 재평가한다.

`packet_budget`에는 모든 provider에 공통인 임의 token 숫자를 고정하지 않는다. Adapter는 대상 model의 tokenizer 또는 runtime telemetry로 packet 크기를 측정한다. 측정 기능이 없으면 UTF-8 byte 수와 추정 token 수를 함께 기록하고, 절감 여부를 `unproven`으로 남긴다. Budget을 넘는 packet은 자동 요약으로 잘라내지 않고 `direct` 또는 `resume-delegate`로 되돌린다.

### 8.2 Runtime decision

각 실행 결정은 static contract와 분리해 기록한다.

```json
{
  "decision_version": "1.0.0",
  "task_id": "task-2",
  "skill": {
    "name": "executing-plans",
    "activation": "explicit"
  },
  "execution": {
    "mode": "persistent-owner",
    "role": "executor",
    "lane": "terra",
    "requested_model": "resolved-by-adapter",
    "effective_model": "unproven"
  },
  "context": {
    "mode": "artifact-reference",
    "authority_hash_verified": true
  },
  "reason": "tasks share state and must run sequentially",
  "tier": "tier1"
}
```

Requested model과 effective model은 같은 field를 공유하지 않는다.

## 9. Runtime adapter 설계

### 9.1 Codex/OMX adapter

계획된 projection은 다음과 같다.

- user-owned `AGENTS.md`의 marker-bounded policy block
- role별 native agent definition
- role별 requested model/reasoning configuration
- canonical contract hash와 version
- skill/routing precedence의 압축된 policy
- capability probe와 tier decision
- static auditor

Tier 1에서는 모든 native subagent spawn이 requested role/model을 사용했다고 주장하지 않는다. Runtime receipt, approvals, spawn-links 또는 reject-capable hook은 capability gate를 통과하기 전에 생성하지 않는다.

### 9.2 Claude Code adapter

계획된 projection은 다음과 같다.

- user-owned `CLAUDE.md`의 marker-bounded policy block
- stable custom subagent definitions
- role별 native model selection
- merge-preserving settings
- 지원되는 hook에만 제한된 validation
- skill activation과 delegation policy 안내
- capability probe와 static auditor

Claude adapter도 full transcript를 custom subagent prompt에 기본 삽입하지 않는다. Role definition은 미리 설치하되 agent instance는 필요할 때만 생성한다.

Claude adapter는 lane의 `reasoning.effort`를 subagent frontmatter의 `effort` 필드로 projection한다. 다만 Claude Code에는 per-subagent thinking toggle이 없어 subagent가 세션 thinking을 상속하므로 `reasoning.thinking: session-inherited`로, effective reasoning을 증명할 metadata가 없으므로 `reasoning.effective: unproven`으로 capability matrix에 보고한다(§8.1).

### 9.3 OpenCode adapter

OpenCode는 named agent, child session과 typed subagent selection이 강한 비교 기준이다. 하지만 v1 구현 범위는 Codex/OMX와 Claude Code다. OpenCode adapter는 native agent와 plugin surface를 별도 capability audit한 뒤 추가한다.

### 9.4 Claude Code spawn guard

Claude Code adapter는 PreToolUse hook 기반 spawn guard를 v1에 포함한다. Hook은 Agent tool 호출의 typed input(subagent type, model)을 contract와 대조해 exit code 2로 거부할 수 있는, 현재 유일하게 신뢰 가능한 pre-dispatch interception 지점이다.

동작 계약은 다음과 같다.

- **판정:** 요청된 subagent type과 model이 contract projection과 일치하면 allow, 불일치하면 deny와 사유를 반환한다.
- **Heartbeat:** hook은 매 판정마다 correlation ID, timestamp, 판정 결과를 append-only evidence log에 기록한다.
- **Fail-open의 정직한 처리:** hook이 비정상 종료(exit 2가 아닌 종료·timeout·crash)하면 tool 호출은 진행된다(fail-open). 이는 Claude Code hooks 문서가 명시한 제약("only exit code 2 blocks the action; any other exit code is non-blocking, execution continues")이므로 숨기지 않는다. 단 v1에는 guard와 독립된 spawn-evidence 생산자가 없으므로 heartbeat 공백만으로 "guard 실패 후 spawn 진행"과 "spawn 없음"을 구분할 수 없다. 따라서 heartbeat는 effective evidence가 아니라 guard 판정 로그로만 취급하고, 공백이 있는 구간은 `effective_model: unproven`으로 남기며 그 구간의 enforcement scope 주장을 철회한다. Guard와 상관검증할 독립 observer는 post-v1(§16)로 둔다.
- **사후 구제의 한계:** heartbeat 공백 감지는 이미 생성된 child를 고칠 수 없다. 정직한 대응은 두 가지뿐이다 — 해당 run을 `unproven`으로 표시하고, 이후 spawn에 대해 guard 복구를 요구한다.
- **Override 탐지:** Claude Code의 model precedence는 환경 변수와 per-invocation model 지정이 agent frontmatter를 우회하도록 허용한다. Guard는 탐지 가능한 override 경로를 판정에 포함하고, 판별 불가능한 경로는 `effective_model: unproven`으로 남긴다.
- **Nested spawn:** child가 다시 spawn하는 경로도 같은 guard를 통과한다. Guard가 관찰할 수 없는 spawn 경로는 coverage 밖임을 audit에 명시한다.
- **이식성:** hook은 shell script에 의존하지 않는 단일 실행형(Node 단일 파일 또는 컴파일 바이너리)으로 배포한다. Windows를 포함한 3개 OS에서 동일하게 동작해야 하며, 경로 처리와 quoting은 platform-neutral하게 구현한다.
- **성능 예산:** 판정 p95 < 50ms, 네트워크 호출 금지, 외부 dependency 없는 실행. Heartbeat 기록은 append-only로 유지한다.

## 10. Tier 1에서의 실제 가치와 한계

Tier 1은 실패 상태가 아니다. 다음을 제공한다.

- deterministic contract generation
- role classification과 provenance 검사
- native configuration projection
- skill/routing policy projection
- delegation 및 context policy의 static fixture audit
- stale model과 configuration drift 탐지
- requested route 기록

Tier 1에서 제공하지 않는 것은 다음과 같다.

- 모든 skill과 spawn path의 사전 차단 보장
- 모든 child의 effective role/model/reasoning 증명
- third-party runtime 내부의 hidden fallback 탐지 보장
- 실제 token 절감 수치의 자동 증명

따라서 Tier 1 결과는 다음 의미를 유지한다.

```json
{
  "tier": "tier1",
  "configuration_enforced": true,
  "semantic_policy_audited": true,
  "role_binding_enforced": false,
  "capabilities": {
    "claude_agent_pre_dispatch": { "status": "enforced", "scope": "Agent tool only" },
    "effective_model": "unproven"
  },
  "status": "partial enforcement"
}
```

## 11. 오류와 충돌 처리

| 조건 | 결과 |
| --- | --- |
| 라우팅 대상 unknown role (또는 `--strict`) | `UNCLASSIFIED_ROLE`, 실행 중단 |
| 라우팅하지 않는 unmanaged installed role | 통과, audit 보고서에 unmanaged로 기록 |
| 공식 model resolution이 모호함 | `AMBIGUOUS_MODEL_RESOLUTION`, 추측 금지 |
| `--target both`에서 한 target만 실패 | 실패 target만 롤백, per-target 결과와 partial-success exit code 보고 |
| Spawn guard 비정상 종료 (fail-open) | heartbeat 공백 감지 시 해당 구간 `unproven` 강등, `scoped` 주장 철회 |
| Task packet이 충분하지 않음 | `direct` 유지 또는 기존 owner resume |
| 명시적 subagent topology와 coupled plan 충돌 | `ROUTE_CONFLICT` |
| Full context가 필요한데 opt-in 없음 | direct/persistent owner 유지 |
| Trusted effective metadata 없음 | `effective_model: unproven` |
| Tier 2 capability 하나라도 미증명 | Tier 1 선택 |
| User-owned marker 밖의 충돌 | write 중단, dry-run diff 보존 |
| Skill이 raw model을 contract와 다르게 지정 | precedence에 따라 reject 또는 explicit override provenance 요구 |

Fallback은 관찰 가능하고 결정적이어야 한다. 조용히 다른 role, model 또는 workflow를 선택하지 않는다.

## 12. 설치 UX

기본 UX는 한 명령에서 adapter를 고르는 방식이다.

```bash
npx orbitlane
```

```text
? Where should OrbitLane install routing configuration?
  Codex / OMX
  Claude Code
  Both
```

비대화형 form은 다음과 같다.

```bash
npx orbitlane install --target codex
npx orbitlane install --target claude
npx orbitlane install --target both
```

Installer는 다음 순서를 지킨다.

1. target runtime과 configuration directory 탐지
2. installed release와 capability probe
3. 변경 대상 snapshot과 manifest 생성
4. dry-run diff 표시
5. marker-owned block과 generated file만 projection
6. static audit
7. 결과 tier와 unproven capability 보고

각 target은 독립 transaction 단위다. Transaction 규칙은 다음과 같다.

- target-local staging에 먼저 쓰고, commit 직전에 원본 파일의 hash를 재확인한다(동시 편집 감지).
- 원본과 staging 불일치 시 write를 중단하고 dry-run diff를 보존한다.
- 파일 교체는 atomic replace로 수행하며, backup은 manifest에 identity(경로, hash, timestamp)를 기록한다.
- 실패한 target은 자기 snapshot으로 자동 롤백한다. `--target both`는 pseudo-atomic으로 묶지 않는다 — 성공한 target은 유지하고 per-target 결과를 보고한다.
- 같은 contract로 재실행하면 diff가 없어야 한다(idempotent). uninstall은 OrbitLane이 소유한 marker block과 generated file만 외과적으로 제거하며, 설치 이후 사용자가 편집한 현재 내용은 pre-install 스냅샷으로 덮어써 복원하지 않고 그대로 보존한다.

성능 예산: `npx orbitlane` 초기 실행은 패키지 다운로드 제외 2초 미만을 목표로 하고, dependency는 이 예산을 지키는 범위로 제한한다. Spawn guard 판정 예산은 §9.4를 따른다. CI에 간단한 성능 회귀 체크를 포함한다.

WSL은 지원되는 Linux 환경이지 dependency가 아니다. Native Linux, macOS와 Windows 경로를 platform-neutral filesystem API로 처리한다.

## 13. 공개 저장소와 개인정보 경계

공개본에는 다음을 포함하지 않는다.

- 실제 username, home directory와 machine-specific absolute path
- private project 이름과 파일
- local evidence bundle과 session identifier
- credential, token, account 정보
- 사용자의 실제 provider model 선택
- 개인 `AGENTS.md` 또는 `CLAUDE.md` 전체 내용
- Git author email이나 private remote
- local backup과 package tarball

공개 예시는 neutral placeholder를 사용한다. Installer fixture는 temporary directory에서 실행한다. User-owned instruction file은 marker 범위 밖의 내용을 보존한다.

## 14. 검증 전략

### 14.1 Contract와 projection

- JSON Schema positive/negative fixtures
- 모든 role의 lane과 provenance 확인
- `executor`와 `team-executor`의 `terra` pin 확인
- 라우팅 대상 unknown role fail-closed 확인 (`--strict` 포함)
- unmanaged installed role이 generation을 막지 않고 audit에 보고되는지 확인
- per-target model binding과 해석 순서(binding > runtime default > `AMBIGUOUS_MODEL_RESOLUTION`) 확인
- installed-release model resolution 근거와 hash 확인
- generated configuration golden test
- marker merge와 rollback test
- installer idempotency 확인 (같은 contract로 2회 실행 시 diff 없음)
- uninstall round-trip 확인 (marker block 제거 후 사용자 원본 복원)
- interrupted write 복구 확인 (staging/commit 중단 후 snapshot 복원)
- 대상 runtime 미설치·미지원 버전 오류 경로 확인
- `--target both` 부분 실패 시 per-target 롤백과 보고 확인

### 14.2 Delegation decision fixtures

아래 fixture는 v1에서 projection된 정책 텍스트의 기대치를 검증한다(Plane 2). 정책을 수행하는 주체는 runtime LLM이므로, fixture 통과는 텍스트 생성의 정확성을 증명할 뿐 runtime 행동을 증명하지 않는다. 행동 검증은 §14.7의 behavioral adherence eval이 담당한다.

| Fixture | 예상 결과 |
| --- | --- |
| 짧은 단일 파일 수정 | `direct` |
| 긴 대화에 의존한 consequential 판단 | `direct` |
| 순차 phase가 같은 state를 공유하는 plan | `persistent-owner` |
| 독립된 세 platform 조사 | `bounded-delegate` |
| 같은 child task의 추가 질문 | `resume-delegate` |
| 사용자가 full context를 명시 | `full-context` |
| Skill 이름이 일반 문장에만 존재 | skill 미활성 |
| `$executing-plans`와 coupled plan | persistent executor |
| `$executing-plans`와 독립 task | gate 통과 task만 delegate |
| `$subagent-driven-development`와 독립 task | explicit delegation 허용 |
| `$subagent-driven-development`와 overlapping write scope | `ROUTE_CONFLICT` |

### 14.3 Context-transfer tests

- 긴 synthetic transcript가 child packet에 복사되지 않았는지 확인
- task packet에 objective, acceptance, constraints, authority, scope와 stop condition이 있는지 확인
- plan, diff, log는 내용 대신 path와 hash로 전달되는지 확인
- resume 경로가 기존 child session identifier를 사용하는지 확인
- completed ledger가 같은 task 재-dispatch를 막는지 확인
- full-context가 explicit opt-in 없이 선택되지 않는지 확인

### 14.4 Token benchmark (post-v1)

Token benchmark harness는 v1 구현 범위에서 제외한다. README가 선언한 "v1에는 telemetry를 넣지 않는다"와 충돌하지 않도록, 이 절은 runtime telemetry가 확보된 이후의 측정 설계로만 유지한다. v1 기간 동안 token 절감 주장은 전부 `unproven`이다.

Token 절감은 문서상의 가정만으로 주장하지 않는다. Runtime이 telemetry를 제공할 때 다음을 측정한다.

- parent input tokens
- child input tokens
- cached read/write tokens
- uncached input tokens
- child turn count
- 전체 작업 완료까지의 model invocation 수

동일한 long-context fixture에 대해 다음을 비교한다.

1. 전체 context를 매번 전달하는 방식
2. bounded task packet 방식
3. direct 또는 persistent owner 방식

Telemetry가 없으면 결과는 `unproven`이다.

### 14.5 Skill compatibility tests

- explicit invocation, plan-declared, hook-proven, advisory mention의 precedence
- known skill integration registry
- unknown skill이 추가 delegation을 만들지 않는지 확인
- skill의 requested role이 canonical contract를 통과하는지 확인
- raw model override의 provenance와 conflict 처리
- Tier 1에서 universal interception을 주장하지 않는지 확인

### 14.6 Public-safety tests

- username, absolute home path, private project name과 secret scan
- WSL-specific dependency scan
- planned command가 shipped feature처럼 표현되지 않았는지 검사
- evidence와 backup directory가 package/repository에 포함되지 않는지 검사
- English README와 Korean README의 status 및 claim boundary 일치

### 14.7 Behavioral adherence eval

Projection된 정책 텍스트가 runtime LLM의 spawn 행동을 실제로 바꾸는지 측정한다. 이는 명시적인 instruction-following 실험이며, enforcement·effective-model binding·token 절감의 증명이 아니다.

- §14.2 fixture 중 5종 내외를 headless Claude Code 시나리오로 실행하고, §9.4 spawn guard의 heartbeat log에서 spawn 발생 여부와 횟수를 측정한다.
- 고정된 runtime 버전과 model 버전에서 실행하고 버전을 결과에 기록한다.
- 정책 블록이 없는 baseline과 projection된 정책 블록이 있는 조건을 비교한다.
- LLM 비결정성을 고려해 반복 시행하고, false-positive(위임해야 하는데 direct)와 false-negative(direct여야 하는데 위임) 기준을 사전 정의한다.
- 명시적 delegation 요청(`$subagent-driven-development` 등)이 과잉 억제되지 않는지 adversarial 케이스를 포함한다.
- 결과는 통과/실패 게이트가 아니라 evidence로 기록한다. CI 게이트로 사용하지 않는다.

## 15. 대안 검토

### 15.1 모든 작업을 subagent에게 위임

장점은 orchestration 규칙이 단순하다는 것이다. 하지만 작은 작업에서도 context transfer와 검증 비용이 생기고, 결합된 plan에서 의도 손실과 반복 읽기가 커진다. 채택하지 않는다.

### 15.2 별도 router model이 전체 context를 분류

복잡한 semantic classification을 중앙화할 수 있다. 그러나 모든 요청에 추가 model invocation과 context 복제를 만든다. Privacy와 failure surface도 넓어진다. 채택하지 않는다.

### 15.3 역할과 agent를 매 task마다 동적으로 생성

작업별 최적화가 가능하지만 role prompt, 권한과 model mapping이 흔들리고 audit이 어렵다. 채택하지 않는다.

### 15.4 미리 정의한 role + on-demand instance + bounded packet

Role의 안정성과 task별 context 최소화를 함께 얻는다. Direct-first gate와 persistent owner로 불필요한 spawn을 줄일 수 있다. 이 설계가 v1 권장안이다.

## 16. 구현 단계

구현은 다음 순서를 따른다. v1은 Plane 1(compile-time 코드)과 Plane 3(Claude spawn guard), 그리고 Plane 2의 정책 텍스트 projection만 포함한다(§6).

1. Contract JSON Schema와 positive/negative fixtures — per-target binding, unmanaged role, capability matrix 포함
2. Stable role catalog와 provider-independent lane mapping
3. 정책 텍스트 projection — precedence, primary owner, delegation/context 규칙의 marker-bounded block 생성과 §14.2 fixture
4. Merge-preserving installer core — per-target transaction, idempotency, uninstall, rollback
5. Codex/OMX Tier 1 adapter와 static auditor
6. Claude Code Tier 1 adapter와 static auditor
7. Claude Code spawn guard(§9.4) — 판정, heartbeat, override 탐지, auditor 연동
8. Cross-platform integration tests (Linux, macOS, Windows)
9. CI와 배포 파이프라인 — 3-OS 매트릭스, §14.6 public-safety 검사, 성능 회귀 체크, npm publish 워크플로우와 버전 태깅. 게시된 패키지로 `npx orbitlane` 설치, spawn guard 실행, rollback이 검증되어야 release gate를 통과한다.
10. Behavioral adherence eval harness (§14.7)

다음은 v1에서 명시적으로 제외한다(post-v1).

- Delegation gate, context packet builder, session manager의 runtime 코드 — v1에서는 정책 텍스트로만 존재한다
- Skill integration registry와 compatibility fixtures — §7의 precedence는 정책 텍스트로만 v1에 포함
- Token benchmark harness (§14.4)
- Spawn guard의 독립 spawn-evidence observer와 session-end correlation (§9.4) — v1은 guard 판정 heartbeat만 기록
- OpenCode adapter (§9.3)
- Codex/OMX 측 Tier 2 (runtime receipt, spawn-link)

Tier 2 hook, runtime receipt와 spawn-link는 capability probe가 모두 true가 되기 전에 구현하거나 활성화하지 않는다. Claude Code spawn guard는 예외적으로 v1에 포함하되 §10의 `scoped` 경계로만 보고한다.

## 17. v1 acceptance criteria

- Contract 하나에서 Codex/OMX와 Claude Code projection을 생성한다.
- 사용자는 Codex, Claude 또는 both를 한 번에 선택해 설치할 수 있다.
- delegation·execution 규칙(`direct` 기본, 계획 크기만으로 spawn 안 함, 결합된 multi-phase plan의 persistent primary owner, on-demand agent instance, deterministic skill/routing precedence, `$executing-plans`가 task별 fresh agent를 자동 의미하지 않음, 명시적 subagent workflow만 topology opt-in)은 v1에서 runtime 코드가 아니라 projection된 정책 텍스트로 존재한다(§16). Acceptance는 다음으로 검증한다:
  - 정책 projection에 각 규칙이 기대 문구로 정확히 포함된다.
  - Golden fixture가 projection된 텍스트를 검증한다(§14.2).
  - Behavioral adherence eval(§14.7)은 관찰 증거만 생성하며 통과 게이트가 아니다.
  - runtime packet/session/ledger의 실제 행동 검증은 post-v1(§16)로 둔다.
- Full transcript 전달은 explicit opt-in이다.
- 라우팅 대상 unknown role과 ambiguous model resolution은 fail closed하고, 라우팅하지 않는 unmanaged installed role은 설치를 막지 않고 audit에 보고된다.
- Tier 결과는 `tier1`/`tier2`로만 보고하며, Claude scoped enforcement는 Tier 1 내부의 capability 객체(`claude_agent_pre_dispatch`)로 표현되고 별도 tier로 승격되지 않는다.
- Claude Code spawn guard가 판정 heartbeat를 남기고, heartbeat 공백 구간은 `effective_model: unproven`으로 강등된다(독립 spawn-evidence correlation은 post-v1).
- Adapter capability matrix가 reasoning 지원을 runtime별로 정직하게 보고한다(Claude: `effort` supported, thinking session-inherited, effective unproven).
- Token 절감은 telemetry-backed benchmark가 없으면 주장하지 않는다.
- 게시된 npm 패키지로 `npx orbitlane`이 3개 OS에서 동작하며, `--target both` 부분 실패가 per-target로 롤백·보고된다.
- Public package와 repository에 개인 path, prompt, source, credential과 local evidence가 포함되지 않는다.
- Linux, macOS, Windows에서 동일 fixture가 통과하며 WSL은 별도 dependency가 아니다.

## 18. 최종 설계 요약

OrbitLane은 model을 고르는 별도 AI proxy가 아니다. "Routing contract compiler"가 정확한 카테고리이며, v1이 실제로 제공하는 것은 네 가지다: routing contract compiler, merge-preserving installer, static drift auditor, 그리고 Claude Code에 한정된 spawn guard. 실행 시점에 모든 요청을 라우팅한다는 인상을 주는 표현은 v1 claim에 사용하지 않으며, README를 포함한 공개 문구는 이 경계와 일치해야 한다(§14.6). Runtime 전반의 라우팅 enforcement는 Tier 2 roadmap이다.

큰 계획은 많은 agent를 의미하지 않는다. 결합된 작업은 한 persistent owner가 수행한다. Independent specialist work만 bounded packet으로 위임한다. Skill은 workflow를 제공하지만 새 agent 생성 자체는 direct-first gate와 explicit topology 규칙을 따른다. Stable subagent role은 미리 정의하되 실제 instance는 필요할 때만 만든다.

Tier 1은 이 정책과 configuration을 결정적으로 생성하고 감사한다. Claude Code spawn guard는 Agent 호출 경로에 한정된 `scoped` enforcement를 제공한다. Tier 2는 모든 spawn path의 trusted interception과 effective metadata가 증명될 때만 추가한다. 이 경계를 유지해야 OrbitLane이 token 비용, context 손실과 과장된 enforcement라는 세 문제를 동시에 피할 수 있다.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found (absorbed) | 11 findings: 7 reinforce D2–D11, 4 new tensions (D12–D15) all accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 13 issues (arch 3, quality 2, tests 3, perf 1, cross-model 4), 0 critical gaps, all folded into this doc |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 11 findings — runtime-orchestrator-on-paper, hook spec gaps, reasoning portability, model-resolution input, installer transactions, cross-platform hooks, eval methodology, CI release gate, positioning. All absorbed into §4.4, §5, §6, §6.7, §8.1, §9.2, §9.4, §11, §12, §14, §16, §17, §18 and both READMEs.

**CROSS-MODEL:** High overlap — Codex independently confirmed the enforcement-plane split (D2/D4) and unmanaged-role decision (D3). Its 4 novel findings (hook spec hardening, Claude reasoning portability, per-target model binding, router positioning) were each user-approved and folded in.

**SECOND-PASS REVIEW (revision 2):** An independent re-review returned REQUEST CHANGES against revision 1 and was verified against official Claude Code docs (v2.1.217). Five factual/consistency findings held and were corrected; two of the re-reviewer's sub-claims were themselves wrong and were not applied. Corrections applied:

1. `reasoning: unsupported` was factually wrong — subagent frontmatter supports `effort` (`low|medium|high|xhigh|max`). Corrected to `effort: supported / thinking: session-inherited / effective: unproven` (§8.1, §9.2, §17).
2. §17 acceptance restated as policy-projection + golden-fixture + observational-eval terms; runtime packet/session/ledger verification moved to post-v1 (§16/§17).
3. `scoped` collapsed into a Tier 1 capability object (`claude_agent_pre_dispatch`); `role_binding_enforced` kept boolean; no third tier (§6.7, §6 report JSON, §10).
4. Spawn-guard heartbeat downgraded from "effective evidence" to a decision log; independent spawn-evidence observer/correlation deferred to post-v1 (§9.4, §16).
5. Both READMEs synced to `sol`/`terra`/`luna` + class vocabulary, routed-unknown vs `unmanaged`, and scoped-capability note.
6. docs/ and both READMEs committed as tracked content; this report pinned to that commit and content hash.
7. Uninstall semantics clarified: surgical removal of marker/generated content only, preserve current user edits (no pre-install snapshot restore) (§12).
8. Not applied (re-reviewer over-corrections): hook fail-open IS documented (§9.4 stands); parent `--model` does not override subagent frontmatter model, which §9.4 already reflects.

**VERDICT:** ENG CLEARED (revision 2) — scope unchanged (v1 = contract compiler + adapters + per-target-transaction installer + static auditor + Claude scoped spawn guard); revision-1 blockers resolved and the above corrections folded. Ready to implement per §16.

NO UNRESOLVED DECISIONS
