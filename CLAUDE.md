# CLAUDE.md

## Build Commands

```bash
pnpm build          # Build all packages
pnpm dev:ui         # Develop UI (Vite)
./dev-rebuild.sh    # Clean, build, install globally, restart
pnpm release        # Build and publish all packages
```

## Core Architecture

### Routing System (`packages/server/src/utils/router.ts`)

- **Default**: `Router.default` configuration
- **Project-level**: `~/.claude/projects/<project-id>/claude-code-router.json`
- **Custom**: `CUSTOM_ROUTER_PATH` JavaScript function
- **Built-in scenarios**: `background`, `think`, `longContext`, `webSearch`, `image`
- **Token calculation**: `tiktoken` (cl100k_base)
- **Subagent routing**: `<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>`

### Transformer System

**Built-in**: `anthropic`, `deepseek`, `gemini`, `openrouter`, `groq`, `maxtoken`, `tooluse`, `reasoning`, `enhancetool`
**Custom**: Load via `transformers` array in `config.json`
**Configuration**: provider-level, model-specific, with options

### Agent System (`packages/server/src/agents/`)

- `shouldHandle(req)` - detect if agent should handle
- `reqHandler(req)` - modify request
- `tools` - provide custom tools

**Flow**: preHandler → add tools → onSend intercept → execute → stream

### SSE Stream Processing

- `SSEParserTransform` - parse SSE to event objects
- `SSESerializerTransform` - serialize events to SSE
- `rewriteStream` - intercept/modify for agent tool calls

### Configuration

**Location**: `~/.claude-code-router/config.json`

- Environment variables: `$VAR_NAME` or `${VAR_NAME}`
- JSON5 format (comments supported)
- Auto-backup (last 3)
- Reload: `ccr restart`

**Validation**: `Providers` requires both `HOST` and `APIKEY`, otherwise listens on `0.0.0.0`

### Logging

**Server-level** (pino): `~/.claude-code-router/logs/ccr-*.log`
**Application-level**: `~/.claude-code-router/claude-code-router.log`

## CLI Commands

```bash
ccr start|stop|restart|status
ccr code
ccr model
ccr preset export|install|list|info|delete <name>
ccr activate
ccr ui
ccr statusline
```

## Preset System

**Location**: `~/.claude-code-router/presets/<preset-name>/manifest.json`

**Core functions** (`packages/shared/src/preset/`):
- `export.ts` - export config with sanitized API keys
- `install.ts` - install, load, list, validate
- `merge.ts` - merge with conflict strategies (ask/overwrite/merge/skip)
- `sensitiveFields.ts` - detect api_key/password/secret

## Development Notes

- Node.js >= 18.0.0
- pnpm (workspace protocol)
- TypeScript: cli/server/shared (CJS), ui (ESM)
- Build: esbuild (cli/server/shared), Vite (ui)
- External: `@musistudio/llms` (core framework), types in `packages/server/src/types.d.ts`
- Code comments: **English only**
- Documentation: Add to docs project, not standalone md files

## UI ConfigProvider (`packages/ui/src/components/ConfigProvider.tsx`)

**Critical**: `fetchConfig` builds a `validConfig` whitelist object. Any new config field **must** be added here, otherwise:

1. Page load constructs `validConfig` without the field
2. 2-second debounce auto-save writes this incomplete config back to server
3. Original field data in `config.json` gets overwritten and lost

**When adding a new config field**: Add it to **both** locations in `ConfigProvider.tsx`:
- `validConfig` object (success path, ~line 77-121)
- Default fallback config (error path, ~line 130-155)

**When adding a new config field to server**: Make sure `requestStatsService` and other singletons from `@musistudio/llms` use **static top-level imports** in `server.ts` and `index.ts`, not dynamic `await import()` inside route handlers, to avoid potential dual-singleton issues with esbuild bundling.