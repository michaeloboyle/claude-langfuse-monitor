#!/usr/bin/env node

/**
 * Claude Langfuse Monitor - Main Module
 *
 * Watches Claude Code conversation files and automatically pushes
 * traces to Langfuse for comprehensive observability.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const chalk = require('chalk');
const { LangfuseClient } = require('@langfuse/client');
const crypto = require('crypto');

class Monitor {
  constructor(options = {}) {
    this.options = {
      historyHours: options.historyHours || 24,
      daemon: options.daemon || false,
      dryRun: options.dryRun || false,
      quiet: options.quiet || false
    };

    this.processedMessages = new Set();
    this.conversationSessions = new Map();
    this.pendingToolSpans = new Map();
    this.messageCount = { user: 0, assistant: 0 };

    // Load configuration
    this.config = this.loadConfig();

    // Initialize Langfuse client
    this.pendingEvents = [];
    if (!this.options.dryRun) {
      this.langfuse = new LangfuseClient({
        publicKey: this.config.publicKey,
        secretKey: this.config.secretKey,
        baseUrl: this.config.host
      });
    }
  }

  loadConfig() {
    // Try to load from config file
    const configFile = path.join(os.homedir(), '.claude-langfuse', 'config.json');

    if (fs.existsSync(configFile)) {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      return config;
    }

    // Fall back to environment variables
    return {
      host: process.env.LANGFUSE_HOST || 'http://localhost:3001',
      publicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
      secretKey: process.env.LANGFUSE_SECRET_KEY || ''
    };
  }

  getClaudeProjectsDir() {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');

    if (!fs.existsSync(projectsDir)) {
      throw new Error(`Claude projects directory not found: ${projectsDir}`);
    }

    return projectsDir;
  }

  async start() {
    console.log(chalk.gray(`📁 Claude projects: ${this.getClaudeProjectsDir()}`));

    // Process existing history
    if (this.options.historyHours > 0) {
      await this.processExistingHistory();
    }

    // Start watching for new activity
    console.log(chalk.cyan('\n👀 Watching for new Claude Code activity...'));
    console.log(chalk.gray(`🔗 Langfuse UI: ${this.config.host}`));
    console.log(chalk.gray('⏹  Press Ctrl+C to stop\n'));

    const watcher = chokidar.watch(
      path.join(this.getClaudeProjectsDir(), '**/*.jsonl'),
      {
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100
        }
      }
    );

    watcher.on('change', (filepath) => {
      this.processConversationFile(filepath);
    });

    watcher.on('add', (filepath) => {
      this.processConversationFile(filepath);
    });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\n🛑 Stopping monitor...'));
      await watcher.close();

      await this.flushPendingEvents();

      console.log(chalk.green('✅ Monitor stopped'));
      process.exit(0);
    });

    // Keep process alive
    return new Promise(() => {});
  }

  async processExistingHistory() {
    console.log(chalk.cyan(`📚 Processing last ${this.options.historyHours} hours...`));

    const projectsDir = this.getClaudeProjectsDir();
    const cutoffTime = Date.now() - (this.options.historyHours * 3600 * 1000);

    const findConversations = (dir) => {
      const results = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          results.push(...findConversations(fullPath));
        } else if (entry.name.endsWith('.jsonl')) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= cutoffTime) {
            results.push(fullPath);
          }
        }
      }

      return results;
    };

    const conversations = findConversations(projectsDir);
    console.log(chalk.gray(`  Found ${conversations.length} recent conversations`));

    for (const filepath of conversations) {
      this.processConversationFile(filepath);
    }

    const totalMessages = this.messageCount.user + this.messageCount.assistant;
    console.log(chalk.green(`✅ Processed ${conversations.length} conversations (${totalMessages} messages: ${this.messageCount.user} user, ${this.messageCount.assistant} assistant)`));
  }

  processConversationFile(filepath) {
    try {
      // Extract project path from file location
      const pathParts = filepath.split(path.sep);
      const projectsIdx = pathParts.indexOf('projects');

      if (projectsIdx === -1 || projectsIdx >= pathParts.length - 2) {
        return;
      }

      const encodedProject = pathParts[projectsIdx + 1];
      const projectPath = encodedProject.replace(/-/g, '/');
      const conversationId = path.basename(filepath, '.jsonl');

      // Get or create session ID
      if (!this.conversationSessions.has(filepath)) {
        const sessionData = `${projectPath}:${conversationId}`;
        const sessionId = crypto.createHash('md5').update(sessionData).digest('hex');
        this.conversationSessions.set(filepath, sessionId);
      }

      const sessionId = this.conversationSessions.get(filepath);

      // Read and process messages
      const content = fs.readFileSync(filepath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          this.processMessage(entry, sessionId, projectPath, conversationId);
        } catch (e) {
          // Skip invalid JSON lines
        }
      }

    } catch (error) {
      console.error(chalk.red(`Error processing ${filepath}: ${error.message}`));
    }
  }

  processMessage(entry, sessionId, projectPath, conversationId) {
    const msgType = entry.type;

    if (!['user', 'assistant'].includes(msgType)) {
      return;
    }

    const uuid = entry.uuid;
    if (!uuid || this.processedMessages.has(uuid)) {
      return;
    }

    // Mark as processed
    this.processedMessages.add(uuid);

    // Extract message content
    let text = '';
    const toolUseBlocks = [];
    const toolResultBlocks = [];
    if (entry.message && typeof entry.message === 'object') {
      // New format: message.content array
      if (entry.message.content && Array.isArray(entry.message.content)) {
        // Extract text from all content block types; collect tool_use/tool_result blocks separately
        text = entry.message.content
          .map(block => {
            if (block.type === 'text' || block.text) {
              return block.text || '';
            } else if (block.type === 'tool_use') {
              toolUseBlocks.push(block);
              return '';
            } else if (block.type === 'tool_result') {
              toolResultBlocks.push(block);
              return Array.isArray(block.content)
                ? block.content.map(c => c.text || c).join('')
                : (block.content || '');
            }
            return '';
          })
          .filter(content => content)
          .join('\n\n');
      }
      // Fallback: old format with direct text field
      if (!text) {
        text = entry.message.text || '';
      }
    } else if (typeof entry.message === 'string') {
      text = entry.message;
    }

    const timestamp = new Date(entry.timestamp || Date.now());

    // Track message counts
    this.messageCount[msgType]++;

    // Print activity (unless quiet mode)
    if (!this.options.quiet) {
      const projectName = projectPath.split('/').pop();
      const preview = text.substring(0, 60).replace(/\n/g, ' ');
      const icon = msgType === 'user' ? '👤' : '🤖';
      console.log(chalk.gray(`${icon} [${projectName}] ${preview}...`));
    }

    if (this.options.dryRun) {
      return;
    }

    // Queue event for batch ingestion
    const eventId = crypto.randomUUID();
    const eventTimestamp = new Date().toISOString();

    if (msgType === 'user') {
      this.pendingEvents.push({
        type: 'trace-create',
        id: eventId,
        timestamp: eventTimestamp,
        body: {
          id: uuid,
          name: 'claude_code_user',
          sessionId: sessionId,
          userId: this.config.userId || 'user@id.not.set',
          input: text,
          timestamp: timestamp.toISOString(),
          metadata: {
            project: projectPath,
            conversationId: conversationId,
            gitBranch: entry.gitBranch,
            cwd: entry.cwd,
            messageType: msgType,
            source: 'claude_code_automatic'
          }
        }
      });

      // Merge tool_result blocks with buffered tool_use spans
      for (const result of toolResultBlocks) {
        const pending = this.pendingToolSpans.get(result.tool_use_id);
        if (pending) {
          this.pendingToolSpans.delete(result.tool_use_id);
          this.pendingEvents.push({
            type: 'span-create',
            id: crypto.randomUUID(),
            timestamp: pending.eventTimestamp,
            body: {
              id: pending.toolCall.id || crypto.randomUUID(),
              traceId: pending.traceId,
              parentObservationId: pending.parentObservationId,
              name: pending.toolCall.name,
              input: pending.toolCall.input,
              output: result.content,
              is_error: result.is_error,
              type: 'tool',
              startTime: pending.timestamp.toISOString(),
              endTime: timestamp.toISOString(),
              metadata: {
                project: pending.project,
                conversationId: pending.conversationId,
                source: 'claude_code_automatic'
              }
            }
          });
        }
      }
    } else if (msgType === 'assistant') {
      this.pendingEvents.push({
        type: 'generation-create',
        id: eventId,
        timestamp: eventTimestamp,
        body: {
          id: uuid,
          traceId: entry.parentUuid,
          name: 'claude_response',
          model: entry.message.model,
          output: text,
          startTime: timestamp.toISOString(),
          endTime: timestamp.toISOString(),
          metadata: {
            project: projectPath,
            conversationId: conversationId,
            requestId: entry.requestId,
            messageType: msgType,
            source: 'claude_code_automatic'
          }
        }
      });

      // Buffer tool_use blocks to be merged with their tool_result when it arrives
      for (const toolCall of toolUseBlocks) {
        this.pendingToolSpans.set(toolCall.id, {
          toolCall,
          traceId: entry.parentUuid,
          parentObservationId: uuid,
          timestamp,
          project: projectPath,
          conversationId,
          eventTimestamp
        });
      }
    }

    // Flush periodically
    if (this.pendingEvents.length >= 10) {
      this.flushPendingEvents();
    }
  }

  async flushPendingEvents() {
    if (!this.langfuse) {
      return;
    }

    // Emit any tool_use spans that never received a matching tool_result
    for (const [, pending] of this.pendingToolSpans) {
      this.pendingEvents.push({
        type: 'span-create',
        id: crypto.randomUUID(),
        timestamp: pending.eventTimestamp,
        body: {
          id: pending.toolCall.id || crypto.randomUUID(),
          traceId: pending.traceId,
          parentObservationId: pending.parentObservationId,
          name: pending.toolCall.name,
          input: pending.toolCall.input,
          type: 'tool',
          startTime: pending.timestamp.toISOString(),
          endTime: pending.timestamp.toISOString(),
          metadata: {
            project: pending.project,
            conversationId: pending.conversationId,
            source: 'claude_code_automatic'
          }
        }
      });
    }
    this.pendingToolSpans.clear();

    if (this.pendingEvents.length === 0) {
      return;
    }

    const events = this.pendingEvents.splice(0);
    try {
      await this.langfuse.api.ingestion.batch({ batch: events });
    } catch (error) {
      console.error(chalk.red(`Error flushing events: ${error.message}`));
    }
  }

  async checkStatus() {
    console.log(chalk.cyan('🔍 Claude Langfuse Monitor Status'));
    console.log(chalk.cyan('='.repeat(50)));

    // Check Claude directory
    try {
      const projectsDir = this.getClaudeProjectsDir();
      console.log(chalk.green('✅ Claude projects directory found'));
      console.log(chalk.gray(`   ${projectsDir}`));
    } catch (error) {
      console.log(chalk.red('❌ Claude projects directory not found'));
      return;
    }

    // Check configuration
    if (this.config.publicKey && this.config.secretKey) {
      console.log(chalk.green('✅ Langfuse credentials configured'));
    } else {
      console.log(chalk.red('❌ Langfuse credentials not configured'));
      console.log(chalk.yellow('   Run: claude-langfuse config --public-key <key> --secret-key <key>'));
      return;
    }

    // Check Langfuse connection
    console.log(chalk.gray(`   Host: ${this.config.host}`));

    console.log(chalk.green('\n✅ Monitor ready to run'));
    console.log(chalk.gray('   Start with: claude-langfuse start'));
  }
}

module.exports = { Monitor };

// If run directly
if (require.main === module) {
  const monitor = new Monitor();
  monitor.start().catch(error => {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  });
}
