# 표준 정합 분석

flow-atlas의 문서 형식에서 항목마다 누가 쓰는지, 어떤 표준과 맞는지를 따져 넣을 것과 뺄 것을 정했다. 기준은 두 가지다.
이 도구가 해결하려는 문제에 실제로 쓰여야 하고, 이미 널리 쓰이는 표준이 있으면 그 모양을 따라 다른 도구가 따로 맞추지
않아도 되게 해야 한다.

## 이 도구가 해결하려는 문제

여러 컴포넌트를 거치는 흐름을 이해하지 못한 채 개발하면 한 모듈이 맡을 일이 여러 곳에 섞인다. flow-atlas는 코드에서 흐름을
뽑아 보여 주고, 사람이 적은 흐름이 코드와 맞는지 확인하고, 어긋난 곳을 작업하는 자리에서 알려 준다. 사람이 읽을 수 있어야
하고, 나중에 e2e 시험 도구와 이을 수 있어야 하며, 에이전트가 쓸 수 있어야 한다.

## 결과를 읽는 쪽

| 읽는 쪽 | 필요한 것 |
|---|---|
| 에이전트 | 라우트와 호출 조회, 흐름 추적, 결과의 안정적인 키, 흐름 상태의 이유 코드 |
| 리뷰어 | PR 본문에 붙일 변경 요약, 그림 |
| 렌더러(Mermaid, HTML) | 노드와 간선, 흐름별 상태 |
| IDE와 코드 리뷰 도구 | 파일과 줄에 붙는 결과 |
| e2e 시험 도구 | 흐름 단계가 가리키는 API 작업 |
| 실행 중 관측(트레이스) | 정적 그래프와 맞춰 볼 라우트 이름 |

## 관심사별 표준

| 관심사 | 표준 | 선택 | 이유 |
|---|---|---|---|
| 사람이 쓰는 흐름 파일의 겉모양 | Kubernetes Resource Model, Backstage 기술자 형식 | 따름 | `apiVersion`, `kind`, `metadata`, `spec` 틀과 labels, annotations를 그대로 쓴다. 저장소 안 YAML로 소프트웨어 구성을 적는 가장 넓게 퍼진 틀이다 |
| 흐름 안의 단계 | Arazzo 1.0 | 따름, 내보내기 제공 | 단계 구조와 이름을 맞췄고 `atlas export arazzo`가 공식 스키마를 통과하는 Arazzo 문서를 만든다 |
| 작성자가 쓴 지식의 출처, 신뢰, 유효기간 | Google Open Knowledge Format(OKF) 0.2 | 따름 | 흐름 파일 `metadata`의 `sources`, `generated`, `verified`, `stale_after`를 OKF 이름과 뜻 그대로 쓴다. 신뢰 등급은 OKF §5.3대로 `verified`에서만 정한다. 파일 형식과 `status`는 가져오지 않았다 |
| 관측 상태 | Kubernetes status conditions | 따름 | `type`, `status`(True, False, Unknown), `reason`, `message`. 시각 필드만 뺐다 |
| 도구가 만든 문서의 출처 | SLSA provenance v1 (in-toto ResourceDescriptor) | 모양을 따름 | 읽은 커밋과 파일을 digest로 남긴다. 빌드 산출물용 규격이라 SLSA 준수를 주장하지는 않는다 |
| 정적 분석 결과 | SARIF 2.1.0 (OASIS) | 내보내기 제공 | GitHub code scanning, VS Code SARIF Viewer, 리뷰 봇이 그대로 읽는다. 공식 스키마를 통과한다 |
| 라우트 이름 | OpenAPI 경로 템플릿 | 따름 | id의 경로를 `{name}`으로 쓴다. 프레임워크와 상관없이 같은 라우트는 같은 id를 가진다 |
| OpenAPI 문서 위치 | 관례적 파일 이름과 프레임워크 기본 경로 | 따름 | `openapi.yaml`, `swagger.json`, Nest `jsonDocumentUrl`과 `<path>-json`, `@fastify/swagger-ui`의 `<prefix>/json`, `/openapi.json` 라우트를 코드에서 찾는다. 서버 주소만 환경 설정으로 받는다 |
| 작업 이름 | OpenAPI operationId | 따름 | 코드에 적힌 operationId를 읽고, 설정하면 @nestjs/swagger 기본 규칙(`Class_method`)으로 만든다 |
| 실행 중 관측과의 결합 | OpenTelemetry HTTP 의미 규약 | 대응만 정함 | `component`는 `service.name`, `method`는 `http.request.method`, 정규화한 `http.route`는 라우트 경로에 대응한다 |
| 그래프 교환 형식 | JSON Graph Format, SARIF graphs | 따르지 않음 | 널리 쓰이는 그래프 교환 표준이 없다. 노드와 간선을 단순하게 두어 렌더러가 바로 쓰게 했다 |
| 컴포넌트 카탈로그 | Backstage Component, API 관계 | 따르지 않음 | 컴포넌트 이름을 Backstage 엔터티 이름과 같게 쓰면 이어진다. 지금 따로 필드를 둘 필요는 없다 |

## 항목별 판단

| 항목 | 쓰는 곳 | 판단 |
|---|---|---|
| `metadata.name` | 흐름 id, Arazzo `workflowId`, 결과 키 | 유지 |
| `metadata.labels` | 렌더러가 흐름을 묶어 보여 줄 때 | 유지 |
| `metadata.annotations` | 도구가 붙이는 위치 정보 | 유지 |
| `metadata.links` | 흐름을 정한 결정 문서 | OKF `sources`로 바꿈 |
| `metadata.generated`, `verified` | 역할을 에이전트가 썼는지, 사람이 검토했는지 | 추가(OKF). 세 부분 경계에서 비어 있던 자리다 |
| `metadata.stale_after` | 의도를 다시 검토할 시점 | 추가(OKF). 코드와의 일치는 매번 확인하지만 의도가 아직 맞는지는 기계가 모른다 |
| `spec.lifecycle` | 백엔드를 먼저 만드는 경우(planned), 폐기(deprecated) | 유지. 백엔드를 먼저 만드는 저장소에서 실제로 필요했던 구분이다 |
| `spec.owner` | 누가 이 흐름을 책임지는지 | 유지 |
| `spec.entry` | 앱이 첫 단계를 부르는지 확인 | 유지. 앱이 부르지 않는 API를 흐름 단위로 잡는다 |
| `spec.produces` | 흐름이 내는 아티팩트가 목록에 있는지 | 유지. 생산자 없는 아티팩트를 흐름과 잇는다 |
| `spec.dependsOn` | Arazzo에서는 실행 순서 | 뺌. 다른 흐름을 한 단계로 쓰는 `flow` 단계로 재사용은 충분하고, 실행 순서는 이 도구가 다루지 않는다 |
| `steps[].role` | 각 컴포넌트가 맡는 일 | 유지. 책임이 섞이는 것을 막는 핵심이다. 도구가 확인하지는 못하고 사람과 에이전트가 읽는다 |
| `steps[].surface`, `call`, `flow` | 단계의 대상 | 유지 |
| 라우트 `operationId` | Arazzo 내보내기, OpenAPI 문서와 결합 | 추가 |
| 라우트 경로 `{name}` 표기 | id 안정성, OpenAPI와 트레이스 결합 | 변경. 이전에는 `:id`처럼 프레임워크 표기를 그대로 썼다 |
| condition `DependenciesDescribed` | `dependsOn` 확인 | 뺌 |
| condition 나머지 다섯 | 렌더러 색, 에이전트 분기 | 유지 |
| condition `Documented` | 작성자 몫(제목, 단계 역할)을 채웠는지 | 추가. 도구가 추측하지 않고 비어 있는지만 본다. [responsibilities.md](responsibilities.md) 참고 |
| `provenance` | 캐시, 비교, 재현 | 유지 |
| 호출 `based`, 라우트 `reaches` | 매칭과 `reach` 간선의 근거 | 유지. 렌더러는 쓰지 않아도 되고 에이전트가 근거를 확인할 때 쓴다 |

## 검증

내보내기 결과를 공식 스키마로 확인한다. `test/standards/`에 SARIF 2.1.0과 Arazzo 1.0의 공식 스키마를 두고, 시험에서 픽스처의
SARIF와 Arazzo 출력을 검사한다. Nest 기본 operationId 규칙은 @nestjs/swagger의 `swagger-explorer.js`에서
`${controllerKey}_${methodKey}`로 확인했다.

## 남은 판단

`role`은 글이라 도구가 확인하지 못한다. 컴포넌트가 맡지 않을 일을 기계가 읽을 수 있게 적는 방법(예: 단계가 거쳐서는 안
되는 컴포넌트)은 실제로 쓰면서 필요가 드러나면 더한다.

e2e 시험은 `atlas export arazzo`로 이어 둔다. Arazzo를 실행하는 도구가 파라미터, 요청 본문, 성공 조건을 채워야 하고, 이것은
코드에서 나오지 않으므로 에이전트나 사람이 채운다.

실행 중 트레이스로 정적 간선을 확인하는 일은 OpenTelemetry 대응표까지만 정했다. e2e 시험이 트레이스를 남기기 시작하면
`service.name`, `http.request.method`, 정규화한 `http.route`로 그래프의 라우트와 맞춰 볼 수 있다.
