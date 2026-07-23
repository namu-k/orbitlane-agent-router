# OrbitLane Two-Layer Installation Design (v3)

> 상태: 승인된 설계 명세
>
> 이 문서는 구현 완료를 주장하지 않는다. 아래 CLI option, resolver 규칙, report 스키마, 불변식은 구현할 대상의 기준이다.

## 1. 문서 목적

이 문서는 OrbitLane을 전역(global) 레이어와 프로젝트(project) 레이어의 2-레이어 모델로 설치할 수 있게 하는 설계를 정의한다.

다루는 범위는 다음과 같다.

- `--global` CLI option과 런타임별 설정 홈 해석
- 불변 content-addressed snapshot 저장소
- 트랜잭션이 보호하는 report를 통한 포인터 원자성
- 모든 훅이 공유하는 런타임 report resolver
- fail-closed 경계와 업그레이드 lockout 완화
- receipt 기반 uninstall
- global Claude guard의 지원 경계

## 2. 배경과 문제

### 2.1 현재 경로 결정

`bin/orbitlane.js`의 `adapters()`는 단일 `root`(`--config-root` 또는 cwd)에서 모든 경로를 파생한다.

- codex: `root/AGENTS.md`, `root/.orbitlane/codex-report.json`
- claude: `root/CLAUDE.md`, `root/.orbitlane/claude-report.json`, `root/.claude/settings.json`

이는 프로젝트 레이아웃 전제다. Claude Code 전역 설정은 `~/.claude/CLAUDE.md` + `~/.claude/settings.json`이므로, 단일 root로는 두 파일을 동시에 올바른 위치에 둘 수 없다. `--config-root ~/.claude`로 실행하면 settings가 `~/.claude/.claude/settings.json`이라는, Claude Code가 읽지 않는 위치로 떨어진다.

Codex 전역은 `~/.codex/AGENTS.md`이므로 `--config-root ~/.codex`로 이미 정상 동작한다.

### 2.2 두 guard의 충돌

`src/guards/claude-spawn.js`의 `evaluateClaudeAgentSpawn`은 fail-closed deny 구조다. 계약에 없는 역할은 `UNCLASSIFIED_ROLE`, 모델 불일치는 `CONTRACT_MISMATCH`로 즉시 거부한다.

Claude Code는 일치하는 훅을 모두 실행하고 가장 제한적인 결정을 적용한다. 따라서 전역 guard와 프로젝트 guard가 서로 다른 계약을 들고 있으면, 전역 guard가 프로젝트 전용 역할을 거부한다. 프로젝트 정책이 전역 정책을 override하지 못한다.

근본 원인은 훅이 두 개라는 사실이 아니라 **각 훅이 설치 시점의 서로 다른 scope-local 계약에 직접 결합된다**는 점이다. v3도 snapshot 자체는 의도적으로 불변 고정하지만, 훅이 결합하는 대상을 snapshot에서 런타임 resolver로 옮긴다.

### 2.3 트랜잭션 밖 계약 덮어쓰기

`createManifest`(`src/installer/index.js:39`)는 instruction, generated, settings 세 파일만 백업한다. 훅은 실행할 때마다 계약을 다시 읽는다(`src/guards/claude-spawn-hook.js`). 고정 경로의 계약을 트랜잭션 밖에서 덮어쓰면, 설치가 실패해 settings가 롤백되어도 **기존 훅이 새 계약을 읽는다**. 원자성이 깨진다.

### 2.4 포괄적 fail-open

fail-open이 두 겹으로 존재한다. 외곽 훅의 `catch { process.exitCode = 0; }`(`src/guards/claude-spawn-hook.js:32-34`)와 `runClaudeSpawnGuard`의 `catch`(`src/guards/claude-spawn.js:45-47`)다. 계약이 없거나 손상돼도 조용히 허용하며, 도구의 fail-closed 정체성과 모순된다.

내부 catch는 평가와 heartbeat 기록을 함께 감싸므로, deny 판정이 기록 실패에 의해 allow로 뒤집히는 경로가 존재한다. 상세는 4.6에서 다룬다.

## 3. 핵심 설계

> 불변 content-addressed snapshot + 트랜잭션이 보호하는 report + 모든 훅이 공유하는 런타임 report resolver

훅 인자는 **위치만** 전달한다. 내용은 런타임에 유도하고, 바이트 해시로 검증하며, 장애 경로에서도 모든 훅이 동일한 판정에 도달한다.

## 4. 컴포넌트

### 4.1 `src/config/paths.js` — 경로 해석 (순수 함수)

```
resolveTargetPaths({ global, configRoot, env, homedir, cwd })
  → { codex:  { instructionPath, generatedPath },
      claude: { instructionPath, generatedPath, settingsPath } }
```

- project 모드(기본): 현행 동작을 그대로 유지한다. root = `configRoot ?? cwd`, claude settings = `root/.claude/settings.json`.
- global 모드: 런타임별 홈으로 해석한다.
  - codex root = `CODEX_HOME` 또는 `~/.codex`
  - claude root = `CLAUDE_CONFIG_DIR` 또는 `~/.claude`
  - claude settings = `<claudeRoot>/settings.json` (평면. `.claude/` 중첩 없음)
- `env`, `homedir`, `cwd`를 주입 가능하게 한다. 테스트가 실제 사용자 홈을 건드리지 않기 위한 필수 seam이다.
- `--global`과 `--config-root`를 동시에 지정하면 `GLOBAL_CONFLICTS_CONFIG_ROOT`로 거부한다.

### 4.2 `src/config/snapshots.js` — 불변 snapshot 저장소

```
<root>/.orbitlane/contracts/<sha256>.json
<root>/.orbitlane/runtime-defaults/<sha256>.json
```

- 계약과 runtime-defaults는 **별도 파일**이다.
- 파일명은 내용의 SHA-256이다. 기존 파일이 있으면 **내용을 검증한 뒤에만** no-op 처리한다. 해시가 일치하지 않으면 실패한다.
- 절대 덮어쓰지 않는다. 설치가 실패하면 새 snapshot은 미참조 orphan으로 남고 기존 참조는 무결하다.
- dry-run에서는 단 한 바이트도 쓰지 않는다. 디렉터리도 만들지 않는다. 경로는 해시로 계산만 한다.

**snapshot은 두 모드 모두에서 기록한다.** 4.1의 "project 모드는 현행 동작 유지"는 경로 해석에 한정된 서술이며 snapshot에는 적용되지 않는다. resolver가 project report의 포인터를 요구하므로(4.4), project 설치도 반드시 자신의 `<root>/.orbitlane/` 아래에 snapshot을 기록하고 report에 포인터를 남긴다. 그러지 않으면 해당 프로젝트는 I2에 의해 pointerless로 판정되어 거부된다.

### 4.3 report를 포인터로 사용 (트랜잭션 재사용)

새 관리 파일을 추가하지 않는다. 이미 트랜잭션이 보호하는 `claude-report.json`에 포인터를 넣는다.

```json
{
  "schema_version": 2,
  "contract_snapshot":         { "sha256": "..." },
  "runtime_defaults_snapshot": { "sha256": "..." }
}
```

`runtime_defaults_snapshot`은 설치 시 runtime-defaults를 제공한 경우에만 존재한다. 필드가 없으면 resolver는 runtime-defaults 없이 계약을 해석하며, 이는 I1의 미지 필드 규칙이 아니라 코어의 명시적 선택 사항이다.

포인터 교체가 원자적이므로 롤백되면 이전 포인터가 이전 snapshot을 가리킨다. installer 트랜잭션 계층은 변경하지 않는다.

**저장하는 것은 해시이지 경로가 아니다.** resolver는 report가 발견된 디렉터리를 기준으로 `<reportDir>/contracts/<sha256>.json`을 유도한다. report에 적힌 임의 경로를 신뢰하면 편집된 report가 guard를 임의 파일로 유도할 수 있다.

### 4.4 `src/guards/resolve-contract.js` — 런타임 공유 resolver

모든 v3 훅이 동일한 resolver를 실행한다. 훅 인자로는 전역 snapshot이 아니라 **전역 report 위치(`CLAUDE_CONFIG_DIR`)만** 전달한다.

선택 규칙:

1. hook payload의 cwd를 canonicalize한다(realpath. symlink 해소).
2. cwd에서 상위로 올라가며 가장 가까운 `.orbitlane/claude-report.json`을 찾는다. 중첩 프로젝트에서는 **최근접 조상이 이긴다**.
3. 없으면 `<CLAUDE_CONFIG_DIR>/.orbitlane/claude-report.json`을 사용한다.
4. 선택된 report에서 해시를 읽고 같은 디렉터리 기준으로 snapshot 경로를 유도한 뒤, **실제 바이트의 SHA-256을 검증**한다.

설치 시점이 다른 훅들도 모두 같은 현재 report를 읽으므로 동일한 effective contract에 도달한다. 충돌이 멱등 중복으로 바뀐다.

### 4.5 guard 실행 순서 교정

현재 훅은 계약을 읽은 뒤(19행) `tool_name !== "Agent"`를 검사한다(21행). 이 순서를 그대로 두고 fail-closed로 바꾸면 Agent와 무관한 모든 도구 호출까지 거부되어 세션 전체가 잠긴다.

v3는 순서를 뒤집는다.

1. `tool_name !== "Agent"`이면 즉시 exit 0. OrbitLane의 관할이 아니다.
2. 그 다음에만 계약을 해석하고, 이 지점부터 fail-closed를 적용한다.

### 4.6 오류 행렬

fail-open은 **두 겹**으로 존재한다. 외곽 훅(`src/guards/claude-spawn-hook.js:32-34`)과 `runClaudeSpawnGuard` 내부(`src/guards/claude-spawn.js:45-47`)다. 외곽만 제거하면 resolver 오류가 내부 catch에서 다시 fail-open된다. 구현 위치에 관계없이 다음 행렬을 만족해야 한다.

| 상황 | 결과 |
| --- | --- |
| 비-Agent 도구 호출 | exit 0. 계약 해석 이전에 반환한다 |
| report/snapshot/schema/hash 검증 실패 | exit 2 deny |
| Agent 입력 오류(`INVALID_AGENT_TOOL_INPUT`) | exit 2 deny |
| 평가 결과가 deny | exit 2 deny. heartbeat 기록 성공 여부와 무관하다 |
| heartbeat 기록 실패 | 판정을 바꾸지 않는다. enforcement claim만 철회한다 |

현재 내부 catch는 **평가와 heartbeat 기록을 함께 감싼다.** 그 결과 `evaluateClaudeAgentSpawn`이 deny를 반환해도 heartbeat 쓰기가 실패하면 catch로 넘어가 deny가 allow로 뒤집힌다. v3는 두 관심사를 분리해 평가 오류와 기록 오류가 서로의 결과를 오염시키지 않게 한다.

heartbeat 기록 실패를 fail-closed로 만들지 않는 이유는, 증거 경로가 읽기 전용이거나 디스크가 가득 찬 상황에서 모든 Agent 스폰이 잠기는 편이 더 나쁜 장애이기 때문이다. 대신 `auditClaudeSpawnGuard`가 이미 구현한 `coverage-withdrawn-heartbeat-gap`으로 enforcement 주장을 철회한다. 증명할 수 없는 것을 주장하지 않는다는 도구의 정체성과 일치한다.

## 5. 불변식

구현은 다음을 반드시 만족한다.

**I1. 동일 `schema_version` 안에서 미지 필드는 의미를 바꾸지 않는다.**
미지 필드는 report 선택, snapshot 경로 유도, allow/deny 판정에 영향을 주지 않는다. resolver가 요구하는 코어는 최소이며 append-only다(`schema_version`, `contract_snapshot.sha256`). 여기에 `runtime_defaults_snapshot.sha256`은 **schema v2부터 의미가 고정된 선택 필드**로 포함한다. 이는 미지 필드가 아니라 정의된 optional 필드이며, 부재는 "runtime-defaults 없음"을 뜻하는 확정된 의미를 갖는다. 선택 규칙이나 코어 필드의 의미가 바뀌면 반드시 breaking schema로 올린다. 이 조건이 성립하므로 구버전 guard는 신버전 report에 forward-compatible하며, `resolver_policy_version`은 판정 게이트가 아니라 heartbeat provenance 기록용으로 충분하다.

**I2. 선택된 scope에서 실패하면 다른 scope로 fallback하지 않는다.**
최근접 project report를 선택한 뒤 손상, pointerless, 해시 불일치, unsupported schema가 발견되면 전역으로 넘어가지 않고 동일하게 deny한다. fallback하면 장애 경로에서 훅마다 판정이 갈리고, 가장 제한적인 결정이 적용되는 규칙 때문에 그대로 충돌이 된다. 포괄적 fail-open은 **두 겹 모두**에서 제거한다(`src/guards/claude-spawn-hook.js:32-34`와 `src/guards/claude-spawn.js:45-47`). 구체적 경계는 4.6의 오류 행렬을 따른다.

**I3. 오류 안내는 선택된 scope에 맞춘다.**
project report 문제는 해당 프로젝트 재설치를, global report 문제는 `orbitlane install --global`을 안내한다. 출력에는 `selected_scope`, `report_path`, 오류 코드를 함께 싣는다. 예: `UNSUPPORTED_REPORT_SCHEMA`는 자기설명적 사유와 함께 거부해 장애가 스스로 해법을 알리게 한다.

**I4. receipt가 없거나 손상되면 uninstall은 명시적으로 실패한다.**
settings의 임의 hook을 제거하지 않는다. 소유권을 증명할 수 없으면 아무것도 지우지 않는다.

## 6. uninstall

`--contract`를 선택 인자로 만든다.

현재 `uninstallOne`은 `adapter.spawnGuardCommand ?? adapter.render()...`(`src/installer/index.js:262`)를 사용하는데, bin이 claude에 항상 `spawnGuardCommand`를 세팅하므로 `??`가 단락되어 `render()`는 호출되지 않는다. 실제 장애물은 `createClaudeTier1Adapter`가 생성 시점에 `resolveClaudeRequestedRoutes`를 호출해(`src/adapters/claude/index.js:106`) 계약 없이는 throw한다는 점이다.

따라서 bin이 Tier1 어댑터 대신 **receipt 기반 경량 uninstall 어댑터**를 만든다. 필요한 것은 경로와 report에서 읽은 검증된 `guard_command`뿐이며, `runTarget`과 `uninstallDiff`가 요구하는 필드는 그것으로 충분하다. `previousGuardCommand`(`src/installer/index.js:107`)가 이미 receipt에서 이전 command를 읽으므로 소유 항목 제거는 지원된다.

이 조건에서 **installer 트랜잭션 계층은 변경하지 않는다.**

### 6.1 `--contract` 선택화 범위

- **install에서는 모든 target에 `--contract`가 필수다.** 선택화는 uninstall에만 적용한다.
- **uninstall에서는 codex, claude, both 모두 생략 가능하다.** `createCodexTier1Adapter`도 생성 시점에 `resolveCodexRequestedRoutes`를 호출해 계약 없이는 throw하므로(`src/adapters/codex/index.js`), receipt 기반 경량 어댑터는 두 target 모두에 필요하다. Codex는 guard가 없으므로 경로 두 개만으로 충분하다.
- `--contract`를 명시하면 기존 경로를 그대로 사용한다. 생략했을 때만 receipt 경로로 진입한다.
- **both에서는 각 target의 receipt를 독립적으로 검증한다.** 한쪽 receipt가 없거나 손상돼도 다른 쪽 uninstall을 막지 않는다. 이는 설치 경로의 target 간 격리 원칙과 동일하다.

### 6.2 "검증된 `guard_command`"의 조건

다음을 **모두** 만족할 때만 소유가 증명된 것으로 본다.

1. report가 JSON으로 파싱된다.
2. `settings_projection.guard_command`가 비어 있지 않은 문자열이다.
3. 그 문자열이 현재 `settings.json`의 `PreToolUse` Agent 항목에 **정확히 일치**하는 형태로 존재한다.

정확히 일치하는 소유 항목만 제거한다. 유사 항목이나 추정 매칭은 하지 않는다.

### 6.3 snapshot 손상과 receipt 손상의 구분

두 실패를 구분한다.

- **snapshot이 사라졌거나 손상됨, receipt는 검증 가능**: uninstall을 진행한다. 훅 항목과 정책 블록을 제거하는 데 계약 내용은 필요 없고, 소유 증명은 6.2로 충족되기 때문이다.
- **receipt가 없거나 손상됨**: I4에 따라 명시적으로 실패한다. settings의 어떤 hook도 건드리지 않는다. 소유를 증명할 수 없으면 아무것도 지우지 않는다.

전역 uninstall은 Claude uninstall이 성공한 뒤에만 소유 snapshot을 정리한다.

## 7. 지원 경계: global Claude guard

훅 command는 설치 시점의 패키지 절대경로를 저장한다(`bin/orbitlane.js:70`). npx나 dlx로 실행하면 그 경로는 휘발성 캐시이며, 캐시가 사라지면 장수하는 전역 훅이 깨진다.

`EPHEMERAL_PACKAGE_ROOT`는 내구성 구현이 아니라 **지원 경계**다. global Claude guard는 persistent package install에서만 지원하고 npx/dlx는 거부한다. hook runtime 벤더링은 `../adapters/*` 서브트리까지 복사해야 하므로 채택하지 않는다.

README는 일반 npx 사용과, persistent runtime이 필요한 global Claude guard를 분리해 표기한다.

## 8. heartbeat

현재 heartbeat는 어떤 계약으로 판정했는지 구분하지 못한다(`src/guards/claude-spawn.js`). 다음을 추가한다.

- `selected_scope` (`project` | `global`)
- `contract_sha256`
- `report_path`
- `resolver_policy_version`

증거와 provenance가 이 도구의 정체성이므로 판정의 출처를 남기는 것은 선택이 아니다.

## 9. legacy 처리

v0.1의 pointerless report는 **pre-1.0 breaking migration 대상으로 지원하지 않는다.** 해당 scope를 재설치해야 하며, release note와 scope-specific 오류로 안내한다.

마이그레이션 심은 만들지 않는다. 포인터 없는 report를 발견하면 I2와 I3에 따라 자기설명적 fail-closed로 처리한다.

## 10. 테스트

**단위**

- `paths.test.js`: project 경로 회귀 불변, global이 `CODEX_HOME`/`CLAUDE_CONFIG_DIR` 존중, claude settings 평면 경로, `GLOBAL_CONFLICTS_CONFIG_ROOT`.
- `snapshots.test.js`: 해시 네이밍, 불변성, 내용 검증 후 no-op, 해시 불일치 실패, dry-run 무기록.
- `resolve-contract.test.js`: 최근접 project report 승리, 부재 시 global fallback, 중첩 프로젝트 규칙, symlink cwd canonicalize, **손상·pointerless·해시 불일치에서 fallback하지 않고 deny**(I2), 전역/프로젝트 guard 판정 일치, 미지 필드가 판정을 바꾸지 않음(I1).
- guard 순서: 비-Agent 도구 호출은 계약 상태와 무관하게 exit 0.

**통합**

- `HOME`, `USERPROFILE`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`을 **전부** 임시 디렉터리로 격리한다. `os.homedir()`는 Windows에서 `USERPROFILE`을 읽으므로 `HOME`만 바꾸면 실제 홈이 오염된다.
- dry-run이 파일시스템을 전혀 변경하지 않음을 assert한다.
- `--target both`에서 Claude 실패가 Codex 설치를 막지 않음을 확인한다.
- `--contract` 없는 uninstall(codex/claude/both), receipt 손상 시 명시적 실패(I4), snapshot만 손상된 경우에는 uninstall 진행(6.3).
- `both` uninstall에서 한쪽 receipt 손상이 다른 쪽 제거를 막지 않음(6.1).
- 오류 출력에 `selected_scope`, `report_path`, 코드가 포함됨(I3).
- 4.6 오류 행렬 전체. 특히 **평가가 deny인데 heartbeat 기록이 실패해도 deny가 유지되는지**, 비-Agent 호출이 계약 상태와 무관하게 exit 0인지.

**`EPHEMERAL_PACKAGE_ROOT` 범위**

- 휘발성 `PACKAGE_ROOT`에서 **global Claude만 거부**한다.
- 같은 조건에서 **global Codex는 계속 허용**한다. Codex에는 guard가 없어 패키지 경로에 의존하지 않는다.
- `--target both`에서는 Codex 성공과 Claude 실패가 함께 유지되는지 확인한다.

**rollback/recovery** (v1 두 번째 blocker를 실제로 닫는 핵심 증거)

1. 계약 A로 설치한다.
2. 계약 B의 snapshot을 생성한 뒤 report/settings commit 중 실패를 주입한다.
3. rollback 후 report가 여전히 A를 가리키고, resolver도 A를 선택하는지 확인한다.
4. 강제 종료(`SIGKILL`) 후 `recover` 경로에서도 동일한 결과인지 확인한다.
5. B snapshot이 orphan으로 남아도 기존 동작에 영향이 없는지 확인한다.

## 11. 비범위

- OpenCode 어댑터. 별도 로드맵 항목이다.
- `--layout` enum. 지금은 불리언으로 충분하다.
- hook runtime 벤더링. 7절의 지원 경계로 대체한다.
- v0.1 report 마이그레이션 심.

## 12. 변경 범위 고지

이 설계는 경로 변경에 국한되지 않는다. guard 해석 로직, report 스키마, CLI 표면이 함께 바뀐다. 다만 installer 트랜잭션 계층은 6절의 조건 아래에서 변경하지 않으므로 기존 원자성 보장을 그대로 재사용한다.
