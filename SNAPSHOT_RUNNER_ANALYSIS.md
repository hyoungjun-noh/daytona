# snapshot_runner DB 테이블 분석

## 1. 개요

`snapshot_runner` 테이블은 **특정 스냅샷(컨테이너 이미지)이 어떤 runner에 존재하는지, 그리고 현재 어떤 상태인지**를 추적하는 매핑 테이블이다. API 서버가 스냅샷을 여러 runner에 분산 배포하고, 각 runner에서의 상태를 주기적으로 동기화하는 데 핵심적인 역할을 한다.

## 2. 엔티티 정의

**파일**: `apps/api/src/sandbox/entities/snapshot-runner.entity.ts`

```typescript
@Entity()
@Index('snapshot_runner_snapshotref_idx', ['snapshotRef'])
@Index('snapshot_runner_runnerid_snapshotref_idx', ['runnerId', 'snapshotRef'])
@Index('snapshot_runner_runnerid_idx', ['runnerId'])
@Index('snapshot_runner_state_idx', ['state'])
export class SnapshotRunner {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'enum', enum: SnapshotRunnerState, default: SnapshotRunnerState.PULLING_SNAPSHOT })
  state: SnapshotRunnerState

  @Column({ nullable: true })
  errorReason?: string

  @Column({ default: '' })
  snapshotRef: string      // 스냅샷의 내부 레퍼런스 (이미지 태그)

  @Column()
  runnerId: string          // 해당 runner의 ID

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
```

## 3. 상태 머신 (State Machine)

**파일**: `apps/api/src/sandbox/enums/snapshot-runner-state.enum.ts`

```typescript
export enum SnapshotRunnerState {
  PULLING_SNAPSHOT  = 'pulling_snapshot',   // 레지스트리에서 runner로 pull 중
  BUILDING_SNAPSHOT = 'building_snapshot',  // runner에서 Dockerfile로 빌드 중
  READY             = 'ready',              // runner에서 사용 가능
  ERROR             = 'error',              // 작업 실패 (errorReason에 원인 기록)
  REMOVING          = 'removing',           // runner에서 제거 중
}
```

**상태 전이 다이어그램:**

```
                      ┌──────────────────┐
                      │  (레코드 생성)    │
                      └────────┬─────────┘
                               │
               ┌───────────────┼───────────────┐
               ▼                               ▼
    ┌──────────────────┐            ┌──────────────────────┐
    │ PULLING_SNAPSHOT │            │ BUILDING_SNAPSHOT    │
    └────────┬─────────┘            └──────────┬───────────┘
             │                                 │
      ┌──────┴──────┐                  ┌───────┴──────┐
      ▼             ▼                  ▼              ▼
   ┌───────┐   ┌─────────┐        ┌───────┐     ┌─────────┐
   │ READY │   │  ERROR  │        │ READY │     │  ERROR  │
   └───┬───┘   └─────────┘        └───┬───┘     └─────────┘
       │                               │
       ▼                               ▼
   ┌──────────┐                   ┌──────────┐
   │ REMOVING │                   │ REMOVING │
   └────┬─────┘                   └────┬─────┘
        │                              │
        ▼                              ▼
   (레코드 삭제)                  (레코드 삭제)
```

## 4. API 서버와 Runner 서버 간 통신 메커니즘

### 4.1 Job 기반 비동기 통신 (V2 Runner)

API 서버는 runner에 직접 HTTP 요청을 보내지 않고, **Job 테이블에 작업을 생성**한다. Runner는 이 Job을 **폴링(polling)** 방식으로 가져와 실행한다.

**파일**: `apps/api/src/sandbox/runner-adapter/runnerAdapter.v2.ts:324-367`

```typescript
// API 서버: PULL_SNAPSHOT Job 생성
async pullSnapshot(snapshotName, registry?, destinationRegistry?, destinationRef?, newTag?) {
  const payload: PullSnapshotRequestDTO = { snapshot: snapshotName, newTag }
  // ... registry 설정 ...
  await this.jobService.createJob(
    null,
    JobType.PULL_SNAPSHOT,        // Job 타입
    this.runner.id,               // 대상 runner
    ResourceType.SNAPSHOT,        // 리소스 종류
    destinationRef || snapshotName, // 리소스 ID
    payload,                      // 작업 페이로드
  )
}
```

**파일**: `apps/api/src/sandbox/runner-adapter/runnerAdapter.v2.ts:279-321`

```typescript
// API 서버: BUILD_SNAPSHOT Job 생성
async buildSnapshot(buildInfo, organizationId?, sourceRegistries?, registry?, pushToInternalRegistry?) {
  const payload: BuildSnapshotRequestDTO = {
    snapshot: buildInfo.snapshotRef,
    dockerfile: buildInfo.dockerfileContent,
    organizationId: organizationId,
    context: buildInfo.contextHashes,
    pushToInternalRegistry: pushToInternalRegistry,
  }
  await this.jobService.createJob(
    null, JobType.BUILD_SNAPSHOT, this.runner.id, ResourceType.SNAPSHOT,
    buildInfo.snapshotRef, payload,
  )
}
```

### 4.2 Runner 서버: Job 실행

Runner는 Job을 폴링해서 가져온 뒤, `Executor`에서 타입별로 분기 처리한다.

**파일**: `apps/runner/pkg/runner/v2/executor/executor.go:141-146`

```go
// Runner: Job 타입별 분기 처리
case apiclient.JOBTYPE_BUILD_SNAPSHOT:
    resultMetadata, err = e.buildSnapshot(ctx, job)
case apiclient.JOBTYPE_PULL_SNAPSHOT:
    resultMetadata, err = e.pullSnapshot(ctx, job)
case apiclient.JOBTYPE_REMOVE_SNAPSHOT:
    resultMetadata, err = e.removeSnapshot(ctx, job)
```

**파일**: `apps/runner/pkg/runner/v2/executor/snapshot.go:44-70`

```go
// Runner: 실제 스냅샷 pull 실행
func (e *Executor) pullSnapshot(ctx context.Context, job *apiclient.Job) (any, error) {
    var request dto.PullSnapshotRequestDTO
    err := e.parsePayload(job.Payload, &request)
    if err != nil { return nil, err }

    err = e.docker.PullSnapshot(ctx, request)  // Docker 이미지 pull
    if err != nil { return nil, err }

    info, err := e.docker.GetImageInfo(ctx, request.Snapshot) // 이미지 정보 조회
    if err != nil { return nil, err }

    return dto.SnapshotInfoResponse{
        Name: request.Snapshot, SizeGB: float64(info.Size) / (1024*1024*1024),
        Entrypoint: info.Entrypoint, Cmd: info.Cmd, Hash: dto.HashWithoutPrefix(info.Hash),
    }, nil
}
```

### 4.3 API 서버: 상태 확인 (Job 완료 여부 기반)

API 서버는 runner에 스냅샷이 존재하는지를 **Job 테이블의 상태**로 판단한다.

**파일**: `apps/api/src/sandbox/runner-adapter/runnerAdapter.v2.ts:376-408`

```typescript
async snapshotExists(snapshotRef: string): Promise<boolean> {
  const latestJob = await this.jobRepository.findOne({
    where: [{
      runnerId: this.runner.id,
      resourceType: ResourceType.SNAPSHOT,
      resourceId: snapshotRef,
      type: Not(JobType.INSPECT_SNAPSHOT_IN_REGISTRY),
    }],
    order: { createdAt: 'DESC' },
  })

  if (!latestJob) return false
  if (latestJob.type === JobType.REMOVE_SNAPSHOT) return false
  if (latestJob.type === JobType.PULL_SNAPSHOT || latestJob.type === JobType.BUILD_SNAPSHOT) {
    return latestJob.status === JobStatus.COMPLETED  // Job이 완료되었으면 존재
  }
  return false
}
```

## 5. SnapshotManager: 핵심 오케스트레이션 레이어

### 5.1 스냅샷 전파 (propagateSnapshotToRunners)

**파일**: `apps/api/src/sandbox/managers/snapshot.manager.ts:296-322`

```typescript
// 각 runner에 대해 snapshot_runner 레코드를 생성하고 pull 요청
const results = await Promise.allSettled(
  runnersToPropagateTo.map(async (runner) => {
    const snapshotRunner = await this.runnerService.getSnapshotRunner(runner.id, snapshot.ref)

    if (!snapshotRunner) {
      // 1) snapshot_runner 레코드 생성 (PULLING_SNAPSHOT 상태)
      await this.runnerService.createSnapshotRunnerEntry(
        runner.id, snapshot.ref, SnapshotRunnerState.PULLING_SNAPSHOT,
      )
      // 2) runner에게 pull Job 생성
      await this.pullSnapshotRunnerWithRetries(runner, snapshot.ref, internalRegistry)
    } else if (snapshotRunner.state === SnapshotRunnerState.PULLING_SNAPSHOT) {
      // 이미 pulling 중이면 상태 확인
      await this.handleSnapshotRunnerStatePullingSnapshot(snapshotRunner, runner)
    }
  }),
)
```

### 5.2 주기적 상태 동기화 (10초마다)

**파일**: `apps/api/src/sandbox/managers/snapshot.manager.ts:132-180`

```typescript
@Cron(CronExpression.EVERY_10_SECONDS)
async syncRunnerSnapshotStates() {
  // PULLING, BUILDING, REMOVING 상태의 레코드를 100개씩 랜덤 추출
  const runnerSnapshots = await this.snapshotRunnerRepository
    .createQueryBuilder('snapshotRunner')
    .where({ state: In([
      SnapshotRunnerState.PULLING_SNAPSHOT,
      SnapshotRunnerState.BUILDING_SNAPSHOT,
      SnapshotRunnerState.REMOVING,
    ]) })
    .orderBy('RANDOM()')
    .take(100)
    .getMany()

  // 각 레코드에 대해 실제 runner 상태와 동기화
  await Promise.allSettled(
    runnerSnapshots.map((snapshotRunner) =>
      this.syncRunnerSnapshotState(snapshotRunner)
    ),
  )
}
```

### 5.3 PULLING 상태 처리 (타임아웃 & 재시도)

**파일**: `apps/api/src/sandbox/managers/snapshot.manager.ts:361-394`

```typescript
async handleSnapshotRunnerStatePullingSnapshot(snapshotRunner, runner) {
  const runnerAdapter = await this.runnerAdapterFactory.create(runner)
  const exists = await runnerAdapter.snapshotExists(snapshotRunner.snapshotRef)

  if (exists) {
    snapshotRunner.state = SnapshotRunnerState.READY  // pull 완료 → READY
    await this.snapshotRunnerRepository.save(snapshotRunner)
    return
  }

  // 60분 타임아웃 → ERROR
  const timeoutMs = 60 * 60 * 1000
  if (Date.now() - snapshotRunner.updatedAt.getTime() > timeoutMs) {
    snapshotRunner.state = SnapshotRunnerState.ERROR
    snapshotRunner.errorReason = 'Timeout while pulling snapshot to runner'
    await this.snapshotRunnerRepository.save(snapshotRunner)
    return
  }

  // 10분 후 재시도
  const retryTimeoutMs = 10 * 60 * 1000
  if (Date.now() - snapshotRunner.createdAt.getTime() > retryTimeoutMs) {
    await this.pullSnapshotRunnerWithRetries(runner, snapshotRunner.snapshotRef, internalRegistry)
  }
}
```

## 6. CRUD 연산 (RunnerService)

**파일**: `apps/api/src/sandbox/services/runner.service.ts:635-710`

| 메서드 | 설명 |
|--------|------|
| `getSnapshotRunner(runnerId, snapshotRef)` | 특정 runner의 특정 스냅샷 레코드 조회 |
| `getSnapshotRunners(snapshotRef)` | 특정 스냅샷의 모든 runner 레코드 조회 (상태순 정렬) |
| `createSnapshotRunnerEntry(runnerId, snapshotRef, state?, errorReason?)` | 레코드 생성 (중복 무시) |
| `getRunnersWithMultipleSnapshotsBuilding(max=6)` | 동시 빌드가 6개 초과인 runner 목록 |
| `getRunnersWithMultipleSnapshotsPulling(max=6)` | 동시 pull이 6개 초과인 runner 목록 |
| `getRunnersBySnapshotRef(ref)` | 특정 스냅샷이 READY인 runner 목록 (ERROR 제외) |

## 7. 전체 데이터 흐름 요약

```
[사용자 요청: 스냅샷 생성]
        │
        ▼
  SnapshotService.createFromPull() / createFromBuildInfo()
        │
        ▼ (이벤트 발행)
  SnapshotManager.syncSnapshotState()  ← 10초 주기 Cron
        │
        ▼
  propagateSnapshotToRunners()
        │
        ├─── snapshot_runner 레코드 생성 (PULLING_SNAPSHOT)   ← DB Write
        │
        ├─── RunnerAdapterV2.pullSnapshot()                   ← Job 테이블에 PULL_SNAPSHOT Job 생성
        │
        ▼
  [Runner 서버: Job 폴링]
        │
        ▼
  Executor.pullSnapshot()  →  Docker.PullSnapshot()          ← 실제 Docker pull 실행
        │
        ▼
  Job 상태 → COMPLETED                                       ← Job 테이블 업데이트
        │
        ▼
  [API 서버: 10초 주기 동기화]
  syncRunnerSnapshotStates()
        │
        ├─── runnerAdapter.snapshotExists() → Job COMPLETED 확인
        │
        ▼
  snapshot_runner.state = READY                               ← DB Update
```

## 8. 핵심 설계 특징

1. **비동기 Job 기반 통신**: API 서버는 runner에 직접 명령하지 않고 Job 테이블에 작업을 기록. Runner가 폴링으로 가져감.
2. **결과적 일관성 (Eventual Consistency)**: 10초 주기 Cron으로 상태를 동기화. 실시간이 아닌 결과적 일관성 모델.
3. **타임아웃 & 재시도**: PULLING 상태에서 10분 후 재시도, 60분 후 ERROR 전환.
4. **동시성 제어**: runner별 동시 pull/build 수를 최대 6개로 제한하여 과부하 방지.
5. **중복 방지**: PostgreSQL unique violation(23505)을 잡아서 중복 레코드 생성을 방지.
6. **분산 락**: Redis 락(`sync-runner-snapshot-states-lock`)으로 여러 API 서버 인스턴스 간 충돌 방지.
