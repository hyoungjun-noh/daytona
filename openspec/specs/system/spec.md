# System Specification: Daytona

## Overview

Daytona is an open-source infrastructure platform that provides secure, elastic environments for executing AI-generated code. It enables developers and AI systems to run untrusted code safely through isolated sandbox environments.

## Core Capabilities

### Sandbox Lifecycle Management
- **Creation**: Sub-90ms sandbox creation from code to execution
- **Isolation**: Each sandbox runs in a fully isolated environment with no cross-sandbox access
- **Snapshotting**: Sandboxes can be snapshotted and restored for state persistence
- **Destruction**: Clean teardown with no residual state

### Programmatic APIs
- **File API**: Read, write, and manage files within sandboxes
- **Git API**: Clone repositories and manage version control within sandboxes
- **LSP API**: Language Server Protocol support for code intelligence
- **Execute API**: Run commands and scripts within sandboxes

### Multi-language SDK Support
- Python SDK (`daytona` on PyPI)
- TypeScript SDK (`@daytonaio/sdk` on npm)
- Go SDK (`github.com/daytonaio/daytona/libs/sdk-go`)
- Ruby SDK (gem-based)

## Architecture

### High-Level Request Flow

```
External API/Client
        ↓
    API Server (NestJS, Port 3000)
        ↓
    Runner (Host-side, Port 3003)
        ↓  Docker API — creates/manages sandbox containers
    Sandbox Container
        ↓
    Daemon (In-sandbox, Port 2280)
        ↓
    File / Process / Git / LSP operations
```

### Service Components

| Service | Language | Runs On | Description |
|---------|----------|---------|-------------|
| API Server | TypeScript (NestJS) | Host | Central REST API for all operations |
| CLI | Go | Client machine | Command-line interface for managing Daytona |
| Runner | Go | Host (Docker-in-Docker) | Orchestrates sandbox containers via Docker API |
| Daemon (Toolbox) | Go | Inside each sandbox | In-sandbox agent providing File/Git/LSP/Execute APIs |
| Proxy | Go | Host | Network proxy for sandbox traffic routing |
| Snapshot Manager | Go | Host | Manages sandbox snapshots and images |
| SSH Gateway | Go | Host | SSH access to sandboxes |
| Dashboard | TypeScript (React) | Host | Web-based management UI |
| OTel Collector | - | Host | OpenTelemetry observability collector |

### Runner–Daemon Relationship

Runner and Daemon are **separate processes running in different containers**:

- **Runner** runs on the host side and manages sandbox lifecycle via Docker API
- **Daemon** runs inside each sandbox container as an agent process

**Daemon injection flow:**
1. Runner writes the `daemon-amd64` static binary to the host filesystem
2. At container creation, Runner mounts it read-only at `/usr/local/bin/daytona`
3. After container start, Runner launches daemon via `docker exec`
4. Runner polls `http://{containerIP}:2280/version` for readiness (up to 60s)

**Runner responsibilities (host-side):**
- Create, start, stop, destroy sandbox containers
- Inject and start daemon binary in each sandbox
- Monitor daemon health via HTTP polling
- Handle Docker events and state synchronization

**Daemon responsibilities (sandbox-side):**
- Toolbox API (port 2280): filesystem, Git, process execution, LSP
- SSH/Terminal server (port 22222)
- Port forwarding, session management
- Computer use plugin support

### Build System
- **Nx** monorepo orchestration for cross-project builds and testing
- **Go workspace** (`go.work`) for Go module management
- **npm** for TypeScript/Node.js dependencies
- **Poetry** for Python SDK packaging

### API Specifications
- OpenAPI specs define the API Server and Runner/Daemon interfaces
- Auto-generated API clients for Python, Go, TypeScript, and Ruby

## Licensing

GNU Affero General Public License v3 (AGPL-3.0)
