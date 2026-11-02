# Flow Atlas 스키마

flow-atlas가 읽고 쓰는 문서의 형식을 정한다. 형식을 먼저 고정하는 이유는 하나다. Mermaid, HTML 뷰어, e2e 시험 도구처럼
나중에 붙일 도구가 이 형식만 읽고 같은 결과를 내야 한다. 형식이 흔들리면 그 사이를 LLM이 메우게 되고, 같은 입력에서
다른 그림이 나온다.

스키마는 `schema/` 아래 JSON Schema(2020-12)로 둔다. TypeScript 타입(`src/model.ts`, `src/flows.ts`)은 스키마를 따르고,
시험은 픽스처와 명령 출력이 스키마를 지키는지 확인한다.

## 바탕이 된 세 규격

직접 새 틀을 만들지 않고 이미 널리 쓰이는 규격 셋을 빌렸다.

Kubernetes Resource Model(KRM)은 Google의 Brian Grant가 정리한 리소스 모델이다. 모든 객체가 `apiVersion`, `kind`,
`metadata`, `spec`, `status`를 가진다. `spec`은 사람이 원하는 상태를 적고, `status`는 컨트롤러가 관측한 상태를 적는다.
상태는 `conditions` 목록으로 쓰고, 각 조건은 `type`, `status`(True, False, Unknown), `reason`, `message`를 가진다.
같은 틀을 쓰는 API라면 CLI, UI, 배포 도구가 한 번만 맞추면 된다는 것이 이 모델의 목적이다. Backstage는 이 틀을 그대로
가져와 저장소의 `catalog-info.yaml`을 기술한다. 저장소 안 YAML로 소프트웨어 구성을 적는다는 점에서 우리와 가장 가까운
선례다.

SLSA provenance는 Google에서 시작해 OpenSSF가 관리하는 산출물 출처 형식이다. 어떤 도구가(`builder`), 어떤 방식으로
(`buildType`), 무엇을 받아(`externalParameters`), 무엇을 읽고(`resolvedDependencies`, 각각 digest 포함) 만들었는지 적는다.
시각은 선택 항목이다.

Arazzo 1.0은 API 호출 순서를 흐름과 단계로 기술한다. 흐름 안의 단계 구조를 여기서 가져왔다.

## 두 층

문서는 누가 쓰느냐에 따라 나눈다.

| 층 | 쓰는 쪽 | 형식 | kind |
|---|---|---|---|
| 흐름 기술 (spec) | 사람과 에이전트 | YAML, `flows/*.flow.yaml` | `Flow` |
| 흐름 모델과 관측 (status) | atlas | JSON, 요청하면 YAML | `Graph`, `Trace`, `Query`, `FlowReport`, `Findings`, `Diff`, `Inventory` |

KRM은 spec과 status를 한 객체에 둔다. 우리는 status를 사람이 쓴 YAML에 다시 써 넣지 않고 `FlowReport`에 따로 둔다.
Backstage도 저장소 파일에는 spec만 두고 관계와 상태는 카탈로그가 붙인다. 사람이 쓴 파일을 도구가 고치면 리뷰와 충돌이
꼬이고, 에이전트가 도구 결과를 손으로 고치는 일도 생긴다.

## Flow

```yaml
apiVersion: flow-atlas.dev/v1alpha1
kind: Flow
metadata:
  name: view-order
  title: 웹 주문 화면에 주문 하나를 보여 준다
  labels:
    domain: orders
  sources:
    - id: screens
      resource: docs/orders.md#screens
      title: 주문 화면 결정
  generated: { by: claude-code/opus-4, at: 2026-10-01T09:00:00Z }
  verified: { by: human:shop-lead, at: 2026-10-02T09:00:00Z }
  stale_after: 2027-04-01T00:00:00Z
spec:
  lifecycle: active
  owner: shop-team
  entry:
    component: web
    description: 주문 화면
  steps:
    - stepId: screen
      surface: "bff|GET /screens/order/{orderId}"
      role: 주문 서비스에서 받은 주문으로 화면을 만든다
    - stepId: read
      surface: "orders|GET /orders/{id}"
      role: 주문 기록을 가진다
  produces: ["document:receipt"]
```

한 파일에 흐름 여러 개를 `---`로 나눠 둘 수 있다. KRM 매니페스트와 같은 방식이다.

`metadata`는 식별과 분류를 맡는다. `name`은 저장소 안에서 겹치지 않는 이름이고 Arazzo의 `workflowId`에 해당한다.
`labels`는 흐름을 골라 보는 데 쓰는 짧은 값이다. `domain: orders`로 묶어 두면 뷰어가 주문 흐름만 따로 보여 줄 수 있다.
`annotations`는 고르는 데 쓰지 않는 값을 도구와 사람이 붙이는 자리다. atlas는 보고서에서
`flow-atlas.dev/location`(파일과 줄)을 붙인다.

나머지 네 칸은 Google의 Open Knowledge Format(OKF) 0.2에서 이름과 뜻을 그대로 가져왔다. OKF는 사람과 에이전트가 쓰고
고치는 지식에 출처, 신뢰, 유효기간을 붙이는 형식이다. 흐름 파일의 제목과 역할도 그런 지식이라 같은 칸을 쓴다.

| 칸 | OKF 절 | 뜻 |
|---|---|---|
| `sources` | §5.1 | 흐름을 정한 결정, 설계 문서, 이슈. `resource`가 필수이고 `id`, `title`, `author`, `last_modified`를 둘 수 있다 |
| `generated` | §5.2 | 누가 의도를 썼는지(`by`)와 언제 마지막으로 의미 있게 바꿨는지(`at`). 에이전트는 `<도구>/<모델>`, 사람은 `human:<id>` |
| `verified` | §5.2 | 누가 확인했는지. 하나면 매핑, 여럿이면 목록. 에이전트는 `human:` 항목을 쓰지 않는다 |
| `stale_after` | §5.5 | 이 시각부터 역할을 다시 검토해야 한다 |

atlas는 `verified`로 신뢰 등급을 정한다(§5.3). 없으면 unverified, `human:`이 아닌 확인만 있으면 machine-confirmed,
`human:`이 있으면 human-reviewed다. 신뢰 등급은 참고 신호이고 `Ready`에 들어가지 않는다. `stale_after`는 `Fresh` 조건이
된다. 비교 기준 시각은 읽은 커밋의 시각이고, 작업 트리를 읽을 때만 지금이다. 그래서 같은 커밋을 다시 읽으면 같은 결과가
나온다.

OKF에서 가져오지 않은 것도 있다. `status`(draft, stable, deprecated)는 문서의 성숙도를 뜻하는데, 우리 `spec.lifecycle`은
코드가 아직 없는 단계(`planned`)를 뜻해서 서로 다르다. 검토 여부는 신뢰 등급이 대신한다. 파일 형식(Markdown과
frontmatter)도 바꾸지 않았다. 단계 구조는 YAML 쪽이 다루기 쉽고, 사람이 읽을 Markdown은 나중에 내보내기로 줄 수 있다.
도구가 만드는 문서에는 OKF의 `generated.at` 대신 시각 없는 `provenance`를 쓴다.

`spec`은 흐름이 지켜야 할 모양이다.

| 필드 | 뜻 | 출처 |
|---|---|---|
| `lifecycle` | `active`는 코드가 흐름을 따라야 한다. `planned`는 단계가 아직 없어도 된다. `deprecated`는 확인하지 않는다 | Backstage `spec.lifecycle` |
| `owner` | 흐름을 책임지는 사람이나 팀 | Backstage `spec.owner` |
| `entry` | 그래프 밖의 시작점(화면 등). 첫 단계를 이 컴포넌트가 불러야 한다 | 추가 |
| `steps` | 흐름이 거쳐야 할 홉 | Arazzo `steps` |
| `produces` | 흐름이 내는 등록 항목(`registry:key`) | 추가 |

단계(step)는 Arazzo의 Step 모양을 따른다. `stepId`를 가지고, `surface`, `call`, `flow` 중 하나로 대상을 가리킨다.
Arazzo의 `operationId`, `operationPath`, `workflowId` 자리다. `role`은 그 단계에서 컴포넌트가 맡는 일이다. 모듈의
책임이 섞이는 것을 막으려면 이것을 글로 남겨야 한다. 단계 사이의 홉은 다 적지 않아도 된다. atlas가 그래프 간선을 따라
다음 단계까지 가장 짧은 길을 찾는다.

Arazzo의 `dependsOn`은 넣지 않았다. Arazzo에서 이것은 실행 순서를 뜻하는데 이 도구는 흐름을 실행하지 않고, 다른 흐름을
재사용하는 일은 `flow` 단계로 충분하다.

Arazzo의 실행 의미는 가져오지 않았다. `parameters`, `requestBody`, `successCriteria`, `onSuccess`, `onFailure`,
`outputs`와 런타임 표현식은 API를 실제로 부르는 도구에 필요하다. flow-atlas는 코드를 읽어 흐름을 확인할 뿐 부르지
않는다. `atlas export arazzo`가 Flow를 Arazzo 1.0 문서로 내보낸다. 라우트에 operationId가 있으면 `operationId`로, 없으면
`operationPath`(`{$sourceDescriptions.bff.url}#/paths/~1orders~1{id}/get`)로 쓴다. 저장소에 둔 문서가 고른 설명이면 그 문서가 쓴 경로 키(`{orderId}`처럼 코드와 다른 파라미터 이름)를 따르고,
문서에 없는 작업은 단계에서 빼고 알린다. `--flow`로 고른 흐름이 부르는 하위 흐름은 함께 내보내고, 내보낼 워크플로가 하나도 없으면 멈춘다. 각 컴포넌트의 OpenAPI 문서는 도구가 찾는다.
후보가 여럿이면 코드로 가릴 수 있을 때만 고른다. 작성자가 `openapi`에 적은 것이 먼저이고, 그다음은 라우트를 읽으라고
설정(`routes[].openapi`)에 준 문서(`ReadForRoutes`), 그다음은 코드의 라우트를
모두 담은 저장소 파일 하나, 그다음은 코드가 내보내는 문서 하나다. 같은 문서를 보여 주는 swagger-ui 경로는 그 문서로 묶는다
(예를 들어 swagger-ui의 `/docs/swagger/json`이 `uiConfig.url`로 `/openapi.json`을 보여 주면 그 별칭이다). 라우트가 빠진 저장소 파일은 낡은 사본으로 보고 차이를 알린다.
이렇게 가려지지 않으면 `ambiguous`로 두고 `export arazzo`는 멈춘다.

고른 문서가 서버가 내보내는 것이면, 그 경로에 붙일 서버 주소는 환경마다 달라서 설정의 `origins`에 적는다. 파라미터, 요청
본문, 성공 조건은 코드에서 나오지 않으므로 Arazzo를 실행하는 쪽이 채운다.

## 모델 문서의 머리

atlas가 쓰는 문서는 모두 같은 머리로 시작한다.

```yaml
apiVersion: flow-atlas.dev/v1alpha1
kind: FlowReport
provenance:
  builder: { id: flow-atlas, version: 0.1.0 }
  buildType: flow-atlas/FlowReport@v1alpha1
  externalParameters:
    ref: origin/main
  resolvedDependencies:
    - { name: code,   uri: ".",                    digest: { gitCommit: fd8775b457... } }
    - { name: config, uri: atlas.config.yaml,      digest: { sha256: 8619fff1... } }
    - { name: flows,  uri: flows/home.flow.yaml,   digest: { sha256: f2fcd80e... } }
```

`provenance`는 SLSA provenance v1에서 네 항목의 이름과 뜻을 가져와 한 층으로 편 flow-atlas 전용 구조다. SLSA에서는
`buildType`, `externalParameters`, `resolvedDependencies`가 `predicate.buildDefinition` 아래, `builder`가
`predicate.runDetails` 아래에 있고 in-toto statement(`_type`, `subject`, `predicateType`)로 감싸지만, 여기서는 그렇게 하지
않으므로 SLSA 소비자에게 그대로 넘길 수 있는 statement가 아니다. `resolvedDependencies`의 각 항목은 in-toto
ResourceDescriptor 모양 그대로다. `externalParameters`에는 호출한 사람이 준 값을 그대로 두고,
`resolvedDependencies`에는 실제로 읽은 커밋과 파일을 digest와 함께 적는다. `origin/main`처럼 움직이는 이름은 앞에,
그 순간의 커밋은 뒤에 남는다. 어떤 입력으로 이 판정이 나왔는지 나중에 다시 확인할 수 있다.

넣지 않은 것도 있다. 만든 시각, 실행한 기계, 절대 경로는 넣지 않는다. 같은 커밋, 같은 설정, 같은 흐름 파일이면 바이트까지
같은 문서가 나와야 비교하고 캐시할 수 있다. 커밋하지 않은 작업 트리를 읽으면 `code`에 digest가 없다.

| kind | 명령 | 담는 것 |
|---|---|---|
| `Graph` | `scan` | 컴포넌트, 라우트, 호출, 간선, 등록 항목, 계약 버전, 설정별 읽은 양 |
| `Trace` | `trace` | 시작 라우트에서 위아래로 이어진 부분 그래프 |
| `Query` | `query` | 조건에 맞는 라우트와 호출, 그리고 한 간선 거리의 이웃 |
| `FlowReport` | `flows` | 흐름마다 metadata와 status |
| `Findings` | `check` | 결과와 그 상태(new, baseline, excepted, expired-exception) |
| `Diff` | `diff` | 두 커밋 사이에 바뀐 라우트, 컴포넌트 연결, 결과 |
| `Inventory` | `inventory` | 설정을 쓸 때 볼 후보 |

`Trace`와 `Query`는 `Graph`와 같은 노드와 간선 모양을 쓴다(`subgraph.schema.json`). 렌더러는 한 가지 모양만 알면 된다.

## 노드와 간선

| 요소 | id | 도구 메타데이터 |
|---|---|---|
| 라우트(surface) | `component\|METHOD /path` | `at`(파일과 줄), `evidence`, `operationId`, `described`(OpenAPI 문서에서 이 작업을 적은 곳), `reaches`(핸들러가 부르는 메서드) |
| 호출(call) | `from->to\|METHOD /path@file#scope` | `at`, `evidence`, `scope`(호출을 담은 함수), `based` |
| 간선(edge) | `kind`, `from`, `to` | `evidence`, `via` |
| 등록 항목 | `registry:key` | `at`, `producers`, `consumers` |
| OpenAPI 문서 | 컴포넌트와 위치 | `kind`(file, served), `convention`(찾은 방식), `aliasOf`(같은 문서를 보여 주는 경로), `agreement`(저장소 파일이 코드의 라우트를 얼마나 담는지), `at` |
| 문서 결정 | 컴포넌트 | `status`(chosen, ambiguous, none), `location`, `reason`, `candidates` |
| 계약 버전 | `family-vN` | `active`, `references` |

라우트 경로는 OpenAPI 경로 템플릿으로 쓴다. Nest나 Express의 `:id`는 `{id}`가 된다. 같은 라우트가 어느 프레임워크로
등록되었든 같은 id를 가지고, OpenAPI의 `paths` 키와 그대로 맞는다. `operationId`는 코드에 적힌 값(라우트 옵션이나
`@ApiOperation`)을 읽고, 설정에서 `operationIds: nest-swagger`를 주면 @nestjs/swagger의 기본 규칙대로 `Class_method`를 만든다.

코드에서 읽지 못하는 프레임워크(Spring, Django, Flask 등)는 그 프레임워크가 만든 OpenAPI 2.0·3.x 문서를 `routes[].openapi`로
준다. 문서의 작업마다 라우트가 생긴다. 경로는 Swagger 2.0의 `basePath`나 OpenAPI 3 첫 서버 URL의 경로를 앞에 붙이고, 호스트와
끝의 `/`는 뺀다. 핸들러 위치는 프레임워크가 operationId를 만드는 규칙(FastAPI `함수_경로_메서드`, Nest `Class_method`,
springdoc 메서드 이름)으로 함수 정의를 찾으면 그곳(`evidence: name`), 코드에 명시한 operationId 문자열이 한 곳에만 있으면 그곳
(`text`), 아니면 문서 위치(`declared`)다. 코드에서도 읽은 라우트는 코드 위치를 그대로 두고 문서의 operationId와 `described`만 더한다.

호출 id에 줄 번호 대신 함수 이름을 쓴다. 위쪽 코드가 바뀔 때마다 id가 바뀌면 흐름 기술이 깨지기 때문이다. 함수가 없는
위치에서만 줄 번호를 쓰고, 같은 id가 겹치면 `~2`처럼 순번을 붙인다.

간선은 두 종류다. `match`는 호출이 대상 컴포넌트의 라우트와 메서드와 경로로 맞는 것이다(호출 → 라우트). `reach`는
라우트 핸들러가 `via` 메서드를 부르고, 그 이름의 메서드 안에 바깥 호출이 있는 것이다(라우트 → 호출).

`evidence`는 그 사실을 어떻게 얻었는지 적는다. `declared`는 매니페스트에 적힌 것, `static`은 구문을 읽은 것, `text`는
글자로 맞춘 것, `name`은 메서드 이름이 같아서 이은 것이다. 렌더러는 이 값으로 선 모양을 바꿀 수 있고, 에이전트는
`name`과 `text` 근거를 코드에서 한 번 더 확인한다.

## FlowReport와 conditions

`FlowReport`의 각 항목은 Flow의 `metadata`와 atlas가 관측한 `status`다. `status.observedRef`는 맞춰 본 커밋이다.
KRM의 `observedGeneration`에 해당한다. `conditions`는 언제나 일곱 개가 같은 순서로 나온다.

| type | True | False | Unknown |
|---|---|---|---|
| `Ready` | 실패한 조건이 없다 (`NoConditionFailed`) | 하나라도 False (`ConditionsFailed`) | 계획 단계가 아직 없다 (`PlannedStepsPending`), 폐기됨 (`Deprecated`) |
| `Resolved` | 모든 단계가 코드에 있다 (`AllStepsResolved`, 계획 단계만 없으면 `PlannedStepsPending`) | 없는 단계가 있다 (`StepNotFound`) | |
| `Connected` | 이웃 단계가 모두 이어진다 (`AllStepsConnected`) | 둘 다 active인 쌍에 길이 없다 (`NoPathBetweenSteps`) | 풀리지 않은 단계 때문에 못 봄 (`StepsUnresolved`), 계획 단계와의 사이가 아직 없음 (`PlannedStepsPending`) |
| `EntryCalled` | 시작 컴포넌트가 첫 단계를 부른다 (`EntryCallsFirstStep`) | 부르지 않는다 (`EntryDoesNotCall`) | `entry` 없음 (`NoEntry`), 첫 단계 없음 (`FirstStepUnresolved`) |
| `ProducesListed` | 적은 등록 항목이 모두 있다 (`AllListed`) | 없는 항목이 있다 (`NotInRegistry`) | 적지 않음 (`NotDeclared`) |
| `Documented` | 제목과 단계별 역할을 적었다 (`TitleAndRolesWritten`) | 제목이 없다 (`TitleMissing`), 역할이 없는 단계가 있다 (`RoleMissing`) | |
| `Fresh` | `stale_after` 전이다 (`BeforeStaleAfter`) | 지났다 (`PastStaleAfter`) | `stale_after`가 없다 (`NoStaleAfter`) |

`Documented`와 `Fresh`는 코드가 아니라 작성자의 몫을 본다. 나머지는 흐름이 코드와 맞는지를 본다. 상태에는 조건과 함께
OKF 신뢰 등급(`trust`)이 들어간다. 누가 무엇을 쓰는지는
[responsibilities.md](responsibilities.md)에 정리했다.

`reason`은 바뀌지 않는 CamelCase 코드라서 도구가 분기에 쓸 수 있고, `message`는 사람이 읽는다. 뷰어는 `Ready`로 흐름의
색을 정하고, 나머지 조건으로 어디가 문제인지 보여 주면 된다. KRM의 `lastTransitionTime`은 뺐다. 시각을 넣으면 같은
입력에서 다른 문서가 나온다. 조건이 언제 바뀌었는지는 두 커밋의 보고서를 `diff`로 비교해서 본다.

`check`의 FA007은 이 conditions와 단계 정보에서 나온다. `active` 흐름에서 False인 항목이 결과가 된다. `planned` 흐름은
모든 단계를 계획으로 보고 조건을 계산하되 결과로 내지 않는다.

## 결과의 SARIF 내보내기

`atlas check --format sarif`는 결과를 SARIF 2.1.0으로 낸다. 결과 키는 `partialFingerprints.flowAtlasKey/v1`, 기준선은
`baselineState`(new, unchanged), 예외는 `suppressions`(external, accepted, 이유는 `justification`)가 된다. 규칙은
`tool.driver.rules`에 이름과 기본 수준(FA002는 error, FA006은 note, 나머지는 warning)으로 들어가고, 문서의 provenance는 run의
`properties`에 담긴다. GitHub code scanning이나 VS Code SARIF Viewer가 그대로 읽는다.

## 버전 정책

`apiVersion`은 지금 `flow-atlas.dev/v1alpha1`이다. KRM 관례대로 alpha 동안에는 필드가 바뀔 수 있다. `v1`로 올린 뒤에는
필드를 지우거나 뜻을 바꿀 때만 버전을 올리고, 더하는 것은 같은 버전 안에서 한다. 스키마는
`additionalProperties: false`라서 더한 필드는 스키마에도 같이 더한다. id 형식(`component|METHOD /path` 등)과 condition의
`reason` 코드도 스키마의 일부다.

## 검증

`atlas flows`는 흐름 파일을 읽을 때 `flow.schema.json`으로 검사한다. 어긋난 문서는 풀지 않고 오류를 적는다. 다른 도구가
모델 문서를 받을 때는 `kind`에 맞는 스키마로 검사하면 된다. 스키마 `$id`는 `urn:flow-atlas:schema:v1alpha1:<이름>`이다.
