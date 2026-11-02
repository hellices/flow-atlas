# flow-atlas

[English](README.md)

모노레포에서 앱, BFF, 백엔드, 에이전트처럼 여러 컴포넌트를 거치는 흐름이 코드 안에서 어긋난 곳을 찾는다.
아무도 부르지 않는 API, 아무도 제공하지 않는 경로를 부르는 클라이언트, 선언하지 않은 경계 호출, 생산자나
소비자가 없는 아티팩트, 더는 쓰지 않는 계약 버전을 파일과 줄 번호로 알려 준다. 결과는 매번 같다. LLM을 쓰지
않고 코드에서 뽑은 사실만 비교한다.

에이전트가 이 결과를 작업 중에 읽게 하려고 만들었다. 에이전트는 한 번에 저장소 일부만 보고 일한다. 그러면
이미 있는 API와 같은 일을 하는 API를 하나 더 만들거나, 서버 쪽만 만들고 앱 연결을 빠뜨리거나, 한 컴포넌트의
책임을 다른 컴포넌트에 섞어 넣기 쉽다. 사람이 리뷰나 정기 점검에서 찾던 이런 어긋남을 작업하는 자리에서
바로 보여 주는 데 목적이 있다. `skills/flow-atlas`의 스킬이 에이전트에게 언제 돌리고 결과를 어떻게 다룰지
알려 준다.

## 도구와 에이전트의 역할

도구는 입력이 같으면 답이 같고 코드로 다시 확인할 수 있는 일만 한다. 어떤 라우트와 호출이 어디에 있는지,
앱 호출에서 BFF 라우트와 그 핸들러가 부르는 포트 메서드를 거쳐 서비스 라우트까지 어떻게 이어지는지, 어떤
어긋남이 새로 생겼는지, 설정이 코드를 얼마나 덮는지를 알려 준다.

에이전트는 의도와 코드 밖 맥락이 필요한 일을 맡는다. 이미 있는 API를 다시 쓸지, 이 흐름에서 각 단계를 어느
컴포넌트가 맡아야 하는지, 결과를 고칠지 예외로 둘지, 설정에 어떤 파일을 넣을지를 정한다. 정한 내용은 예외 파일,
설정, 피드백처럼 도구가 다시 읽는 파일에 남긴다. 그래야 다음 실행과 다음 에이전트가 같은 판단을 이어받는다.

그래서 도구는 고치는 방법을 정해 주지 않는다. `explain`은 결과의 위치와 비슷한 경로의 호출이나 라우트만 보여
주고, 판단에 쓸 설명은 스킬의 rules.md에 있다. 설정 초안도 만들지 않는다. `inventory`가 후보 파일을 늘어놓으면
에이전트가 고른다.

## 무엇을 찾나

| 규칙 | 찾는 것 |
|---|---|
| FA001 | 저장소 안 어떤 클라이언트도 부르지 않는 라우트 |
| FA002 | 대상 컴포넌트가 제공하지 않는 경로를 부르는 호출 |
| FA003 | 매니페스트에 선언하지 않은 컴포넌트 간 호출, 컴포넌트 순환 |
| FA004 | 생산자나 소비자가 없는 등록 항목(아티팩트, 도구, 이벤트) |
| FA006 | 활성 목록에도 없고 아무 데서도 이름을 부르지 않는 계약 버전 |
| FA007 | 흐름 기술에 적었지만 코드에 없거나 이어지지 않는 단계 |

규칙별 원인과 고치는 방법은 [rules.md](skills/flow-atlas/references/rules.md)에 있다. 계약 필드 중 만들기만 하고
읽지 않는 필드를 찾는 FA005는 아직 만들지 않았다. 스키마와 타입을 함께 읽어야 해서 문자열 비교로는 부족하다.

## 설치

Node 20 이상이 필요하다. 이 저장소는 CLI와 그 CLI를 쓰는 에이전트 스킬을 함께 담는다. 스킬은 Agent Skills
규격(agentskills.io)을 따르므로 GitHub Copilot, Claude Code, Codex, Cursor 같은 에이전트에서 같은 방식으로 쓴다.

CLI는 저장소에서 바로 받거나, 릴리스에 올린 패키지(`npm pack`으로 만든 tgz)로 받는다.

```bash
npx github:hellices/flow-atlas --help          # 설치 없이 실행. 설치할 때 prepare가 빌드한다
npm install -g github:hellices/flow-atlas      # atlas 명령으로 설치
npm install -g <릴리스의 flow-atlas-x.y.z.tgz 주소>   # 빌드된 패키지로 설치
```

최근 npm은 설치 스크립트 실행에 승인을 요구할 수 있다. 저장소에서 바로 받을 때 `prepare`가 막히면 릴리스 패키지를 쓴다.

스킬은 `skills/flow-atlas` 폴더다. GitHub CLI 2.90 이상이면 `gh skill install hellices/flow-atlas flow-atlas`로
에이전트별 위치에 설치한다. 직접 복사해도 된다(예 `.github/skills/`, `.agents/skills/`, `~/.copilot/skills/`).

저장소에서 개발할 때는 이렇게 한다. 레지스트리 미러로 의존성을 받는다면 `git config filter.public-registry.clean "node scripts/public-registry.mjs"`와 `git config filter.public-registry.smudge cat`으로 미러 주소가 커밋되는 lockfile에 들어가지 않게 한다.

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

## 쓰는 법

```bash
atlas inventory --root <repo>                 # 컴포넌트, 라우트, 클라이언트 호출, 버전 파일 후보
atlas scan --root <repo>                      # 설정의 각 항목이 무엇을 얼마나 읽었는지
atlas query --path /orders                    # 경로나 컴포넌트로 라우트와 호출 찾기
atlas trace "bff|GET /screens/order/{id}"     # 호출자부터 하위 서비스까지 이어진 흐름
atlas draft flow "bff|GET /screens/home"      # 코드에서 흐름 초안 만들기, 작성자 몫은 표시만
atlas flows                                   # 흐름 기술을 코드에 맞춰 본 결과
atlas check --format sarif > atlas.sarif      # 결과를 SARIF 2.1.0으로 (GitHub code scanning, VS Code)
atlas export arazzo                           # 흐름을 Arazzo 1.0으로 (e2e 시험 도구). OpenAPI 문서 위치는 코드에서 찾고 서버 주소만 origins로
atlas check --root <repo>                     # 기준선 이후 새로 생긴 결과
atlas check --root <repo> --since main        # main에 없던 결과만
atlas diff main..WORKTREE --format markdown   # 흐름 변화와 새 결과를 PR 본문용으로
atlas explain <key>                           # 결과 하나의 위치와 비슷한 경로
atlas baseline update                         # 지금 결과를 받아들인 부채로 기록
atlas feedback <key> false-positive --note "이유"
atlas stats                                   # 규칙별 조치율과 오탐률
```

`--ref <commit>`을 주면 체크아웃하지 않고 그 커밋의 파일을 읽는다. 쓰기는 모두 `--out`으로 간다. 그래서 손대면
안 되는 저장소도 `--out`을 저장소 밖으로 두면 읽기만 하고 분석할 수 있다.

설정 작성법은 [config.md](skills/flow-atlas/references/config.md)에 있다. 처음에는 `scan` 결과를 보며 두세 번
고쳐야 결과를 믿을 만해진다.

## 운영 방식

처음 설정을 맞춘 뒤 `atlas baseline update`로 지금 있는 결과를 기준선으로 남긴다. 그 뒤로는 새로 생긴 결과만
보인다. 이미 쌓인 부채는 기준선에서 따로 줄여 가고, 작업자는 자기 변경이 만든 결과만 다룬다.

새 결과는 고치거나 예외 파일에 이유를 남긴다. 예외에는 근거가 된 결정과 다시 볼 날짜를 적는다. 날짜가 지나면
결과가 다시 나타난다. 결과가 틀렸으면 `feedback`으로 남기고, `stats`로 규칙마다 오탐률을 본다. 오탐률이 높은
규칙은 설정에서 끄거나 추출기를 고친다.

기본으로 막지 않고 알려 주기만 한다. CI에서 막고 싶으면 `--fail-on-new`를 쓴다.

## 도구, 에이전트, 스킬의 몫

코드에서 확정할 수 있는 것은 도구가 만든다. 라우트, 호출, 연결, operationId, 흐름의 단계와 시작점, 흐름이 코드와 맞는지,
어긋난 곳이 그렇다. `atlas draft flow`도 trace 경로를 따라 흐름 초안을 만들고, 정하지 못하는 칸은 `agent:` 주석으로 남긴다.

의도가 필요한 것은 에이전트나 사람이 쓴다. 흐름의 제목, 단계마다 컴포넌트가 맡는 일, 담당자, 계획 상태, 예외의 이유가
그렇다. 도구는 이것을 추측하지 않고 채웠는지만 확인한다(`Documented` 조건).

어떤 일이 어느 컴포넌트의 몫인지 읽어 내는 판단은 스킬이 기준을 준다. 저장소 규칙, 흐름의 역할, 코드 순으로 따르고, 결함과
계획과 오탐을 가르는 기준을 둔다. 자세한 경계는 [docs/responsibilities.md](docs/responsibilities.md)에 있다.

## 흐름 기술과 스키마

에이전트나 사람이 `flows/*.flow.yaml`에 흐름을 적는다. 겉모양은 Kubernetes 리소스처럼 `apiVersion`, `kind: Flow`,
`metadata`(이름, labels, 그리고 Google OKF의 sources, generated, verified, stale_after), `spec`으로 쓰고, `spec.steps`는 Arazzo처럼 단계로 쓴다. 단계는 OpenAPI 작업 대신 이
저장소의 라우트나 호출을 가리키고, 그 단계에서 컴포넌트가 맡는 일(`role`)을 적는다.

`atlas flows`는 흐름마다 status를 낸다. 단계가 코드에 있는지, 다음 단계까지 간선으로 이어지는지, 시작 컴포넌트가 첫
단계를 부르는지를 Kubernetes처럼 `conditions`(type, status, reason, message)로 적고, 어떤 흐름에도 속하지 않는 라우트를
알려 준다. 어긋나면 `check`가 FA007로 보고한다.

`--format json`이나 `--format yaml`로 받는 문서는 모두 `schema/`의 JSON Schema를 따른다. 문서마다 `apiVersion`, `kind`,
그리고 SLSA provenance 모양의 `provenance`(도구, 받은 인자, 읽은 커밋과 파일의 digest)가 있고 시각은 넣지 않는다. 같은
입력이면 같은 문서가 나오므로 시각화나 다른 도구가 LLM 없이 읽을 수 있다. 형식과 그렇게 정한 이유는
[docs/schema.md](docs/schema.md)에 있다.

표준과는 이렇게 맞춘다. 흐름 파일의 겉모양은 Kubernetes와 Backstage, 단계는 Arazzo, 상태는 Kubernetes conditions, 출처는
SLSA provenance를 따른다. 라우트 경로는 OpenAPI 경로 템플릿(`{id}`)으로 쓰고 operationId를 읽는다. 결과는 SARIF 2.1.0으로,
흐름은 Arazzo 1.0으로 내보내며 둘 다 공식 스키마로 시험한다. 항목마다 왜 넣고 뺐는지는
[docs/standards.md](docs/standards.md)에 있다.

## 흐름 추적

`trace`는 두 가지 연결을 잇는다. 호출과 라우트는 메서드와 경로가 맞으면 잇는다(`=`). 컴포넌트 안에서는 라우트
핸들러를 로컬 함수, 상대 경로 import, re-export를 따라 읽고 그 안에서 부르는 멤버 메서드 이름을 모은다. 같은
컴포넌트의 바깥 호출이 그 이름의 메서드 안에 있으면 잇는다(`~`). 포트와 어댑터로 나눈 구조에서 핸들러가
`deps.backend.getOrder()`를 부르고 어댑터의 `getOrder`가 HTTP를 부르는 경우가 이렇게 이어진다. 이름으로 잇기
때문에 `get`, `send` 같은 흔한 이름을 거친 연결은 코드를 열어 확인한다.

## 라이선스

MIT. `test/standards/`의 공식 스키마는 각 발행처의 조건을 따른다.

## 시험

```bash
pnpm test
```

`fixtures/shop`은 일부러 어긋남 아홉 개를 심은 작은 모노레포다. 시험은 아홉 개가 모두 나오고 그 밖에는
나오지 않는지, 기준선과 예외와 `--since`가 맞게 동작하는지, `--ref`로 커밋을 체크아웃 없이 읽는지, 웹 호출에서
BFF 핸들러의 포트 호출을 거쳐 주문 서비스까지 흐름이 이어지는지, 흐름 기술이 코드와 맞는지와 어긋날 때 FA007이
나오는지, 모든 명령의 JSON과 YAML 출력이 스키마를 지키는지 확인한다.

## 한계

라우트와 호출은 코드의 문자열에서 읽는다. 경로를 여러 함수에 걸쳐 조립하거나 서버 응답에서 받은 URL로
부르면 호출을 보지 못하고 FA001로 보고한다. 설정에 적은 파일만 읽으므로 결과가 없다고 흐름이 완전하다는
뜻은 아니다. 결과를 따르기 전에 해당 위치를 열어 확인한다.
