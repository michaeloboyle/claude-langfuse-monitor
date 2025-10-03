# Claude Langfuse Monitor

> **Automatic Langfuse tracking for Claude Code**
> Zero instrumentation. No code changes. Set up once, track forever.

[![npm version](https://badge.fury.io/js/claude-langfuse-monitor.svg)](https://www.npmjs.com/package/claude-langfuse-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**⚠️ Community Project**: This is an independent tool, not affiliated with Anthropic or Langfuse. See [Legal Notice](#legal-notice) below.

Just like [Claude Analytics](https://www.npmjs.com/package/claude-code-templates) provides comprehensive insights into your Claude Code usage, `claude-langfuse-monitor` automatically tracks all Claude Code activity in your self-hosted Langfuse instance.

## Features

✅ **Zero Instrumentation** - No code changes, decorators, or manual tracking required
✅ **Automatic Coverage** - All conversations, all projects, all messages
✅ **Real-Time Streaming** - See activity appear in Langfuse as it happens
✅ **Session Grouping** - Conversations grouped by project and session
✅ **Historical Backfill** - Process last 24 hours on startup
✅ **System Service** - Run automatically on login (macOS LaunchAgent)
✅ **Production Ready** - Token usage, costs, performance metrics

## Quick Start

### Install globally with npm

```bash
npm install -g claude-langfuse-monitor
```

### Or run with npx (no install)

```bash
npx claude-langfuse-monitor start
```

### Configure Langfuse connection

```bash
claude-langfuse config \
  --host http://localhost:3001 \
  --public-key pk-lf-... \
  --secret-key sk-lf-...
```

### Start monitoring

```bash
claude-langfuse start
```

That's it! All your Claude Code activity will now appear in Langfuse at `http://localhost:3001`

## Why This Tool?

### The Problem

**Langfuse** is amazing for production LLM observability - tracking API calls, tokens, costs, and performance. But it requires manual instrumentation:

```python
# Manual instrumentation required
from langfuse import observe

@observe(name="my_operation")
def my_function():
    # your code here
```

**Claude Analytics** (`npx claude-code-templates@latest --analytics`) provides automatic tracking by reading Claude's conversation logs - but it's focused on development analytics, not production LLM monitoring.

### The Solution

`claude-langfuse-monitor` combines the best of both:

- ✅ **Automatic** like Claude Analytics (no code changes)
- ✅ **Production-grade** like Langfuse (tokens, costs, traces)
- ✅ **Self-hosted** (complete control over your data)

## How It Works

1. **Watches** `~/.claude/projects/` for conversation file changes
2. **Parses** user messages and Claude responses in real-time
3. **Pushes** traces to your Langfuse instance automatically
4. **Groups** by session and project for easy navigation

```
Claude Code → ~/.claude/projects/*.jsonl → Monitor → Langfuse
                                             ↓
                                  Automatic Tracking!
```

## Commands

### Start the monitor

```bash
# Foreground (testing)
claude-langfuse start

# With custom history processing
claude-langfuse start --history 48  # Last 48 hours

# Background daemon
claude-langfuse start --daemon
```

### Configuration

```bash
# Configure Langfuse credentials
claude-langfuse config \
  --host http://localhost:3001 \
  --public-key pk-lf-... \
  --secret-key sk-lf-...

# Check status
claude-langfuse status
```

### System Service (Auto-start on login)

```bash
# Install as macOS LaunchAgent
claude-langfuse install-service

# Uninstall service
claude-langfuse uninstall-service

# View logs
tail -f ~/Library/Logs/claude-langfuse-monitor.log
```

## What You'll See in Langfuse

### Traces

- **Name**: `claude_code_user` (user messages) / `claude_response` (Claude responses)
- **Session ID**: Grouped by conversation
- **User ID**: `michael@oboyle.co` (configurable)
- **Input/Output**: Full message content
- **Metadata**:
  - Project path
  - Git branch
  - Working directory
  - Conversation ID
  - Request ID

### Example Trace

```json
{
  "id": "a1b2c3d4-...",
  "name": "claude_code_user",
  "sessionId": "3f2e1d0c...",
  "userId": "michael@oboyle.co",
  "input": "implement automatic langfuse tracking for all claude activity",
  "metadata": {
    "project": "/Users/you/Documents/github/myproject",
    "conversationId": "f82888dc-994a-4260-bb07-604901f62e2b",
    "gitBranch": "main",
    "source": "claude_code_automatic"
  }
}
```

## Requirements

- **Node.js**: 16.0.0 or higher
- **Langfuse**: Self-hosted instance running (see [Langfuse Docs](https://langfuse.com/docs/deployment/self-host))
- **Claude Code**: Active usage with conversation history in `~/.claude/`

## Setting Up Langfuse

If you don't have Langfuse running yet:

```bash
# Clone and start Langfuse
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker-compose up -d

# Access at http://localhost:3001
# Get your API keys from Settings → API Keys
```

See [Langfuse Self-Hosting Guide](https://langfuse.com/docs/deployment/self-host) for detailed setup.

## Configuration File

Config stored at `~/.claude-langfuse/config.json`:

```json
{
  "host": "http://localhost:3001",
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-..."
}
```

## Troubleshooting

### No traces appearing?

1. Check Langfuse is running: `curl http://localhost:3001/api/public/health`
2. Verify credentials: `claude-langfuse status`
3. Check Claude directory exists: `ls ~/.claude/projects/`
4. View monitor logs: `tail -f ~/Library/Logs/claude-langfuse-monitor.log`

### Monitor not starting automatically?

```bash
# Check service status (macOS)
launchctl list | grep claude-langfuse

# Restart service
launchctl stop co.oboyle.claude-langfuse-monitor
launchctl start co.oboyle.claude-langfuse-monitor

# View service logs
tail -f ~/Library/Logs/claude-langfuse-monitor.log
```

### Messages processed but session field blank?

This is a known limitation in Langfuse Python SDK 3.6.0. The monitor generates session IDs and displays them in console output. Future versions will support full session UI integration.

## Contributing

Contributions welcome! This is an open-source project.

```bash
git clone https://github.com/michaeloboyle/claude-langfuse-monitor.git
cd claude-langfuse-monitor
npm install
npm start
```

## Legal Notice

This is an independent community project and is not affiliated with, endorsed by, or sponsored by Anthropic PBC or Langfuse GmbH.

- **Claude Code** is a product of Anthropic PBC
- **Langfuse** is a product of Langfuse GmbH
- **This tool** is provided "as is" under MIT License

Use of this tool is subject to Claude Code's terms of service and Langfuse's terms of service.

**Note on Privacy**: This tool reads conversation files stored locally by Claude Code (`~/.claude/projects/`). All data is sent only to your self-hosted Langfuse instance. No data is sent to third parties.

## License

MIT License - See [LICENSE](LICENSE) file for details.

This software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement.

## Author

**Michael O'Boyle**
Website: [oboyle.co](https://oboyle.co)
Email: michael@oboyle.co

## Related Projects

- [Langfuse](https://langfuse.com) - LLM observability platform
- [Claude Code](https://claude.ai/code) - AI-powered coding assistant
- [Claude Analytics](https://www.npmjs.com/package/claude-code-templates) - Claude Code usage analytics

---

**Built with ❤️ for the Langfuse and Claude Code communities**
