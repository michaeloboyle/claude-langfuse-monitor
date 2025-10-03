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
const { Langfuse } = require('langfuse');
const crypto = require('crypto');

class Monitor {
  constructor(options = {}) {
    this.options = {
      historyHours: options.historyHours || 24,
      daemon: options.daemon || false,
      dryRun: options.dryRun || false
    };

    this.processedMessages = new Set();
    this.conversationSessions = new Map();

    // Load configuration
    this.config = this.loadConfig();

    // Initialize Langfuse client
    if (!this.options.dryRun) {
      this.langfuse = new Langfuse({
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

      if (this.langfuse) {
        await this.langfuse.shutdownAsync();
      }

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

    console.log(chalk.green(`✅ Processed ${conversations.length} conversations`));
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
    if (entry.message && typeof entry.message === 'object') {
      text = entry.message.text || '';
    } else if (typeof entry.message === 'string') {
      text = entry.message;
    }

    const timestamp = new Date(entry.timestamp || Date.now());

    // Print activity
    const projectName = projectPath.split('/').pop();
    const preview = text.substring(0, 60).replace(/\n/g, ' ');
    const icon = msgType === 'user' ? '👤' : '🤖';

    console.log(chalk.gray(`${icon} [${projectName}] ${preview}...`));

    if (this.options.dryRun) {
      return;
    }

    // Create trace in Langfuse
    try {
      if (msgType === 'user') {
        this.langfuse.trace({
          id: uuid,
          name: 'claude_code_user',
          sessionId: sessionId,
          userId: 'michael@oboyle.co',
          metadata: {
            project: projectPath,
            conversationId: conversationId,
            gitBranch: entry.gitBranch,
            cwd: entry.cwd,
            messageType: msgType,
            source: 'claude_code_automatic'
          },
          input: text,
          timestamp: timestamp
        });
      } else if (msgType === 'assistant') {
        this.langfuse.generation({
          id: uuid,
          traceId: entry.parentUuid,
          name: 'claude_response',
          model: 'claude-sonnet-4-5-20250929',
          metadata: {
            project: projectPath,
            conversationId: conversationId,
            requestId: entry.requestId,
            messageType: msgType,
            source: 'claude_code_automatic'
          },
          output: text,
          startTime: timestamp,
          endTime: timestamp
        });
      }

      // Flush periodically
      if (this.processedMessages.size % 10 === 0) {
        this.langfuse.flushAsync();
      }

    } catch (error) {
      console.error(chalk.red(`Error creating trace: ${error.message}`));
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
