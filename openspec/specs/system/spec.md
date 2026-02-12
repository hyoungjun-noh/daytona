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

### Service Components

| Service | Language | Description |
|---------|----------|-------------|
| API Server | TypeScript (NestJS) | Central REST API for all operations |
| CLI | Go | Command-line interface for managing Daytona |
| Runner | Go | Code execution runtime within sandboxes |
| Daemon (Toolbox) | Go | In-sandbox agent providing File/Git/LSP/Execute APIs |
| Proxy | Go | Network proxy for sandbox traffic routing |
| Snapshot Manager | Go | Manages sandbox snapshots and images |
| SSH Gateway | Go | SSH access to sandboxes |
| Dashboard | TypeScript (React) | Web-based management UI |
| OTel Collector | - | OpenTelemetry observability collector |

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
