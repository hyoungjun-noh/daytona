# Spec: Backup Snapshot Image Lifecycle Management

## Summary

현재 백업 스냅샷 이미지의 생성(Creation)은 자동화되어 있으나, 삭제(Deletion) 및 정리(Cleanup) 관련 로직이 불완전하다. DB 레코드와 레지스트리 이미지를 함께 관리하는 단일 메소드가 존재하지 않으며, `existingBackupSnapshots` 배열은 무한히 증가하고, 개별 백업 이미지 태그에 대한 자동 삭제 메커니즘이 없다. 이로 인해 레지스트리 스토리지 낭비, 고아 이미지(orphaned images) 발생, DB 참조 불일치 등의 문제가 발생할 수 있다.

---

## 1. 현재 상태 분석 (As-Is)

### 1.1 백업 이미지 생성 플로우

| 단계 | 위치 | 설명 |
|------|------|------|
| 트리거 | `backup.manager.ts` cron jobs | `ad-hoc-backup-check`(5분), `syncStopStateCreateBackups`(10초) |
| 이미지 네이밍 | `backup.manager.ts:319-320` | `{registry}/{project}/backup-{sandboxId}:{timestamp}` |
| 상태 전이 | `sandbox.entity.ts:setBackupState()` | NONE → PENDING → IN_PROGRESS → COMPLETED |
| DB 기록 | `sandbox.entity.ts:242-248` | COMPLETED 시 `existingBackupSnapshots` 배열에 append |

### 1.2 백업 이미지 삭제 플로우 (현재)

| 이벤트 | 동작 | 문제점 |
|--------|------|--------|
| Sandbox Destroyed | `deleteSandboxBackupRepositoryFromRegistry()` 호출 | 레포지토리 단위 삭제만 시도. 개별 태그 삭제 아님 |
| 24시간 후 | `cleanupDestroyedSandboxes()` cron이 Sandbox 레코드 DB 삭제 | 레지스트리 이미지 삭제 실패 여부와 무관하게 DB 삭제 |
| 수동 | Admin API `canCleanupImage()` 조회 후 외부에서 삭제 | 자동화 없음, 외부 의존 |

### 1.3 관련 메소드 현황

| 메소드 | 위치 | 기능 | 호출처 |
|--------|------|------|--------|
| `deleteBackupImageFromRegistry()` | `docker-registry.service.ts:704` | 개별 이미지 태그 삭제 (manifest digest 기반) | **호출처 없음 (Dead Code)** |
| `deleteSandboxRepository()` | `docker-registry.service.ts` | 레포지토리 전체 삭제 | Sandbox destroy 시 |
| `removeImage()` | `docker-registry.service.ts:482` | 이미지 아티팩트 삭제 | 스냅샷 cleanup에서만 사용 (백업과 무관) |
| `canCleanupImage()` | `snapshot.service.ts:580` | 이미지 삭제 가능 여부 확인 | Admin REST API only |
| `setBackupState()` | `sandbox.entity.ts:228` | 백업 상태 전이 + existingBackupSnapshots append | `sandbox.service.ts:updateSandboxBackupState()` |

---

## 2. 식별된 문제점

### 2.1 [Critical] existingBackupSnapshots 무한 증가

- **현상**: `setBackupState(COMPLETED)` 시 배열에 append만 하고, 제거하는 코드가 어디에도 없음
- **영향**: 장기 운영 시 sandbox entity 크기 무한 증가, JSONB 쿼리 성능 저하
- **위치**: `sandbox.entity.ts:242-248`

### 2.2 [Critical] 자동 백업 이미지 삭제 메커니즘 부재

- **현상**: 백업 이미지를 레지스트리에서 자동으로 삭제하는 cron job이나 이벤트 핸들러가 없음
- **영향**: 레지스트리 스토리지가 시간에 따라 무한히 증가
- **현존 cron jobs**: 생성 관련 3개, 상태 모니터링 1개 — **삭제 관련 0개**

### 2.3 [High] DB-Registry 불일치 가능성

- **시나리오 1**: `deleteSandboxBackupRepositoryFromRegistry()` 실패 시 에러 로그만 남기고 계속 진행 → 레지스트리에 이미지 잔존
- **시나리오 2**: 레지스트리에서 이미지가 외부적으로 삭제되었으나 DB `existingBackupSnapshots`에 참조 잔존
- **시나리오 3**: Sandbox destroy 후 24시간 내 레코드 삭제되면 참조 추적 불가

### 2.4 [High] Dead Code — deleteBackupImageFromRegistry

- **현상**: `docker-registry.service.ts:704`에 정의된 `deleteBackupImageFromRegistry()` 메소드가 어디에서도 호출되지 않음
- **분석**: 개별 이미지 태그 삭제 기능이 구현되어 있으나 실제 워크플로우에 연결되지 않음

### 2.5 [Medium] 백업 복원 시 실패한 이미지 정리 부재

- **현상**: `sandbox-start.action.ts:739-766`에서 복원 시 `existingBackupSnapshots`를 역순 순회하며 유효한 이미지를 찾지만, 실패한(레지스트리에 없는) 이미지 참조를 배열에서 제거하지 않음
- **영향**: 매번 복원할 때마다 동일한 실패를 반복

### 2.6 [Medium] canCleanupImage Race Condition

- **현상**: canCleanupImage 체크와 실제 삭제 사이에 lock이 없음
- **영향**: 체크 후 삭제 전에 새 sandbox가 해당 이미지를 참조할 수 있음

### 2.7 [Low] canCleanupImage SQL Injection 가능성

- **현상**: `snapshot.service.ts:595-598`에서 `imageName`을 Raw SQL 쿼리에 직접 interpolation
- **영향**: Admin API이므로 위험도는 낮으나 방어적 코딩 원칙에 위배

---

## 3. 필요 피처

### 3.1 백업 이미지 통합 삭제 메소드

DB 레코드 업데이트 + 레지스트리 이미지 삭제를 트랜잭션으로 처리하는 단일 서비스 메소드.

```
deleteBackupSnapshot(sandboxId, snapshotName):
  1. Redis lock 획득 (sandbox 단위)
  2. 레지스트리에서 이미지 삭제 (deleteBackupImageFromRegistry 활용)
  3. sandbox.existingBackupSnapshots에서 해당 항목 제거
  4. sandbox.backupSnapshot이 해당 이미지면 null로 초기화
  5. DB 저장
  6. Redis lock 해제
```

### 3.2 existingBackupSnapshots 정리 정책

- **최대 보관 개수**: N개 초과 시 가장 오래된 것부터 삭제 (FIFO)
- **최대 보관 기간**: M일 초과 항목 자동 삭제
- COMPLETED 시 append 전에 정책 적용

### 3.3 백업 이미지 자동 정리 Cron Job

```
cleanup-orphaned-backup-images (매 N분):
  1. DESTROYED 상태 sandbox의 existingBackupSnapshots 이미지 삭제
  2. 레지스트리에서 이미지 삭제 후 DB 참조 제거
  3. 정리 결과 로깅 및 메트릭 수집
```

### 3.4 복원 실패 시 stale 참조 정리

`sandbox-start.action.ts`의 복원 로직에서 레지스트리에 존재하지 않는 이미지 참조를 `existingBackupSnapshots`에서 제거.

---

## 4. 의사결정 필요 사항

### Decision 1: existingBackupSnapshots 보관 정책

| 옵션 | 설명 | 장점 | 단점 |
|------|------|------|------|
| **A. 개수 제한** | 최근 N개만 보관 (e.g., 5개) | 구현 단순, 예측 가능 | 빈번한 백업 시 최근 데이터만 남음 |
| **B. 기간 제한** | 최근 M일만 보관 (e.g., 7일) | 시간 기반으로 직관적 | 비활성 sandbox는 백업이 없을 수 있음 |
| **C. 개수 + 기간** | 둘 중 먼저 도달하는 조건 적용 | 균형 잡힌 정책 | 구현 복잡 |
| **D. 최소 1 + 기간** | 최소 1개 항상 유지 + 기간 초과분 삭제 | 복원 가능성 보장 | 최소 1개의 스토리지 항상 점유 |

### Decision 2: 삭제 실패 시 처리 전략

| 옵션 | 설명 |
|------|------|
| **A. DB 선반영** | DB에서 먼저 참조 제거 → 레지스트리 삭제 시도 (실패 시 고아 이미지 발생 가능, 별도 GC로 수거) |
| **B. Registry 선삭제** | 레지스트리 먼저 삭제 → 성공 시 DB 참조 제거 (실패 시 stale 참조 잔존, 복원 시 자연 정리) |
| **C. 2-Phase** | 삭제 예정(soft delete) 마킹 → 레지스트리 삭제 → DB 확정 삭제 |

### Decision 3: 자동 정리 Cron 범위

| 옵션 | 설명 |
|------|------|
| **A. Destroyed sandbox만** | DESTROYED 상태인 sandbox의 백업만 정리 |
| **B. 모든 sandbox** | 활성 sandbox도 보관 정책 초과분 정리 |
| **C. Destroyed + 정책 초과** | DESTROYED는 전체 삭제, 활성은 정책 초과분만 삭제 |

### Decision 4: deleteBackupImageFromRegistry Dead Code 처리

| 옵션 | 설명 |
|------|------|
| **A. 활용** | 새 통합 삭제 메소드에서 기존 코드를 호출하도록 연결 |
| **B. 재작성** | 기존 코드 삭제 후 새로운 설계에 맞게 재구현 |

### Decision 5: canCleanupImage 개선 범위

| 옵션 | 설명 |
|------|------|
| **A. 유지** | 외부 Admin 전용으로 현재 역할 유지 |
| **B. 내부 활용** | 자동 정리 cron에서도 삭제 전 체크 용도로 활용 |
| **C. 통합** | 통합 삭제 메소드 내부로 로직 흡수, 별도 API 폐기 |

---

## 5. 현재 라이프사이클 흐름도

```
┌─────────────────────────────────────────────────────────────────────┐
│                    BACKUP IMAGE LIFECYCLE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐    ┌─────────┐    ┌─────────────┐    ┌───────────┐  │
│  │  CREATE   │───▶│ PENDING │───▶│ IN_PROGRESS │───▶│ COMPLETED │  │
│  │ (Cron/API)│    └─────────┘    └─────────────┘    └─────┬─────┘  │
│  └──────────┘                                             │         │
│                                                           ▼         │
│                                          ┌────────────────────────┐ │
│                                          │ existingBackupSnapshots│ │
│                                          │ 배열에 append          │ │
│                                          │ (제거 로직 없음) ⚠️    │ │
│                                          └────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ SANDBOX DESTROYED                                            │   │
│  │  1. backupState → NONE (backupSnapshot = null)               │   │
│  │  2. deleteSandboxBackupRepositoryFromRegistry() 호출         │   │
│  │     └─ 실패 시 로그만 남기고 계속 ⚠️                        │   │
│  │  3. 24h 후: sandbox DB 레코드 삭제                           │   │
│  │     └─ existingBackupSnapshots도 함께 삭제됨                 │   │
│  │     └─ 레지스트리 이미지 삭제 실패 시 고아 이미지 잔존 ⚠️   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 자동 정리 메커니즘: 없음 ⚠️                                 │   │
│  │ - 개별 이미지 태그 삭제 cron: 없음                           │   │
│  │ - existingBackupSnapshots pruning: 없음                      │   │
│  │ - 고아 이미지 탐지/삭제: 없음                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. 관련 파일

| 파일 | 주요 라인 | 역할 |
|------|-----------|------|
| `apps/api/src/sandbox/entities/sandbox.entity.ts` | L155-158, L228-262 | `existingBackupSnapshots` 정의, `setBackupState()` |
| `apps/api/src/sandbox/managers/backup.manager.ts` | L319-320, L368-379, L441 | 백업 생성, 레포지토리 삭제, destroy 이벤트 핸들러 |
| `apps/api/src/sandbox/services/sandbox.service.ts` | L1232-1243, L2011-2029 | Sandbox destroy, backup 상태 업데이트 |
| `apps/api/src/sandbox/managers/sandbox-actions/sandbox-start.action.ts` | L739-766 | 백업 복원 로직 |
| `apps/api/src/docker-registry/services/docker-registry.service.ts` | L482-510, L704-765 | `removeImage()`, `deleteBackupImageFromRegistry()` |
| `apps/api/src/sandbox/services/snapshot.service.ts` | L580-611 | `canCleanupImage()` |
