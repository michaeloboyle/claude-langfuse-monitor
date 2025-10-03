# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`claude-langfuse-monitor` is a Node.js CLI tool that automatically tracks Claude Code activity by monitoring conversation files (`~/.claude/projects/**/*.jsonl`) and pushing traces to a self-hosted Langfuse instance in real-time. Zero-setup automatic observability for all Claude Code usage.

## Core Architecture

**File watching → JSON parsing → Langfuse trace creation**

- **[bin/claude-langfuse.js](bin/claude-langfuse.js)**: CLI entry point using Commander for commands (`start`, `config`, `status`, `install-service`, `uninstall-service`)
- **[index.js](index.js)**: Main `Monitor` class containing all core logic
  - `chokidar` watches `~/.claude/projects/**/*.jsonl` for file changes
  - Parses JSONL conversation entries (user/assistant messages)
  - Creates Langfuse traces/generations with session grouping
  - Maintains `processedMessages` Set for deduplication
  - Maps conversations to session IDs via `conversationSessions` Map
- **[scripts/install-service.js](scripts/install-service.js)**: macOS LaunchAgent installer for auto-start on login

**Key Flow**: File change event → `processConversationFile()` → read JSONL → `processMessage()` → `langfuse.trace()` or `langfuse.generation()` → Langfuse UI

**Configuration**: `~/.claude-langfuse/config.json` stores Langfuse host, publicKey, secretKey

## Development Commands

### TDD Workflow (MANDATORY)

All development must follow Test-Driven Development:

```bash
# 1. Write tests first
npm test:watch

# 2. Run full test suite
npm test

# 3. Check test coverage (80% threshold required)
npm test:coverage

# 4. Only commit when tests pass
git add . && git commit -m "Feature: description"
```

### Running the Monitor

```bash
# Install dependencies
npm install

# Run monitor locally (foreground with 24h history)
npm start

# Or with explicit Node execution
node index.js

# Install as global CLI tool
npm install -g .

# Then use CLI commands
claude-langfuse start                    # Full verbose output
claude-langfuse start --quiet            # Quiet mode (summaries only)
claude-langfuse start --history 1        # Process last 1 hour only
claude-langfuse config --host http://localhost:3001 --public-key pk-lf-... --secret-key sk-lf-...
claude-langfuse status
claude-langfuse install-service
```

## Testing

### Unit Tests

Test suite located in `__tests__/monitor.test.js` with 20 tests covering:
- Config loading (file, env vars, defaults)
- Message parsing and deduplication
- Session ID generation (MD5 hashing)
- File watching and JSONL parsing
- Edge cases and error handling

```bash
# Run all tests
npm test

# Watch mode for TDD
npm test:watch

# Coverage report (80% threshold)
npm test:coverage

# Run specific test file
npx jest __tests__/monitor.test.js

# Run tests matching pattern
npx jest -t "session ID"
```

### Integration Testing

```bash
# Dry run (no Langfuse calls, just file processing)
node bin/claude-langfuse.js start --history 1

# Watch in real-time with verbose output
node index.js

# Test specific conversation file
node -e "
const { Monitor } = require('./index.js');
const m = new Monitor({ dryRun: true });
m.processConversationFile('/Users/you/.claude/projects/your-project/conversation-id.jsonl');
"
```

### Test Mocks

- **Langfuse SDK**: Custom mock in `__tests__/__mocks__/langfuse.js` to avoid ESM import issues
- **File system**: Mocked with jest.mock('fs') for deterministic tests
- **Chokidar**: Mocked to test file watching logic without actual file events

## Key Implementation Details

### Session ID Generation
Session IDs use MD5 hash of `projectPath:conversationId` to group related messages in Langfuse. Stored in `conversationSessions` Map for consistency across file watches.

### Message Deduplication
`processedMessages` Set tracks UUIDs to prevent duplicate traces when files are re-read (e.g., on file change events or historical backfill).

### Trace vs Generation
- **User messages**: `langfuse.trace()` with name `claude_code_user`
- **Assistant responses**: `langfuse.generation()` with name `claude_response`, linked via `traceId: entry.parentUuid`

### Project Path Decoding
Encoded project paths in file structure (e.g., `~/.claude/projects/Users-you-Documents-github-myproject/`) are decoded by replacing `-` with `/`.

### Historical Backfill
`processExistingHistory()` scans all conversation files modified within `historyHours` (default 24h) before starting the file watcher.

## Configuration Files

- **~/.claude-langfuse/config.json**: Langfuse credentials (host, publicKey, secretKey)
- **~/Library/LaunchAgents/co.oboyle.claude-langfuse-monitor.plist**: macOS service definition (created by `install-service`)

## Deployment

Published to npm as `claude-langfuse-monitor`. Users install globally with `npm install -g claude-langfuse-monitor` or run via `npx claude-langfuse-monitor start`.

System service auto-starts on macOS login after running `claude-langfuse install-service`. Logs to `~/Library/Logs/claude-langfuse-monitor.log`.

## Dependencies

- **chokidar**: File system watcher with proper event handling and write-finish detection
- **commander**: CLI argument parsing and command structure
- **chalk**: Terminal color output for user feedback
- **langfuse**: Official Langfuse Node.js SDK for trace creation

## Extending the Monitor (TDD Required)

### Adding New Trace Metadata

1. **Write test first** in `__tests__/monitor.test.js`:
   ```javascript
   test('includes new metadata field', () => {
     const entry = { type: 'user', uuid: 'test', message: 'Hello', newField: 'value' };
     // Test expectation here
   });
   ```

2. **Run test** (should fail): `npm test:watch`

3. **Implement feature** in `processMessage()` in [index.js](index.js):
   - Modify metadata objects passed to `langfuse.trace()` or `langfuse.generation()`

4. **Verify test passes**: Check watch output

5. **Test with dry run**: `node index.js` (no Langfuse calls)

### Supporting New Conversation Formats

1. **Write tests** for new format parsing
2. **Update JSONL parsing** in `processConversationFile()`
3. **Handle new message types** in `processMessage()` type checks
4. **Verify coverage**: `npm test:coverage` (maintain 80%+)

### Before Committing

```bash
# Required checks
npm test                    # All tests must pass
npm test:coverage          # Coverage must be ≥80%
node index.js --dry-run    # Integration test
```
