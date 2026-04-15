#!/usr/bin/env node

/**
 * Claude Langfuse Monitor - CLI Entry Point
 *
 * Automatic tracking of Claude Code activity in Langfuse.
 * Works just like Claude Analytics - no setup required!
 */

const { program } = require('commander');
const chalk = require('chalk');
const { Monitor } = require('../index');

program
  .name('claude-langfuse')
  .description('Automatic Langfuse tracking for Claude Code activity')
  .version('1.0.0');

program
  .command('start')
  .description('Start monitoring Claude Code activity')
  .option('-d, --daemon', 'Run as background daemon')
  .option('-h, --history <hours>', 'Process last N hours of history (default: 0, skip backfill)', '0')
  .option('-q, --quiet', 'Quiet mode - only show summaries, not individual messages')
  .action(async (options) => {
    console.log(chalk.cyan('🔍 Claude Langfuse Monitor'));
    console.log(chalk.cyan('='.repeat(50)));

    const monitor = new Monitor({
      historyHours: parseInt(options.history),
      daemon: options.daemon,
      quiet: options.quiet
    });

    try {
      await monitor.start();
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Configure Langfuse connection')
  .option('--host <url>', 'Langfuse host URL', 'http://localhost:3001')
  .option('--public-key <key>', 'Langfuse public key')
  .option('--secret-key <key>', 'Langfuse secret key')
  .option('--user-id <userId>', 'user id to use in the trace')
  .action((options) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const configDir = path.join(os.homedir(), '.claude-langfuse');
    const configFile = path.join(configDir, 'config.json');

    // Create config directory if needed
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Save configuration
    const config = {
      host: options.host,
      publicKey: options.publicKey,
      secretKey: options.secretKey,
      userId: options.userId
    };

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    console.log(chalk.green('✅ Configuration saved'));
    console.log(chalk.gray(`   Config file: ${configFile}`));
  });

program
  .command('status')
  .description('Check monitor status and connection')
  .action(async () => {
    const monitor = new Monitor({ dryRun: true });
    await monitor.checkStatus();
  });

program
  .command('install-service')
  .description('Install as system service (launchd on macOS)')
  .action(async () => {
    const installer = require('../scripts/install-service');
    await installer.install();
  });

program
  .command('uninstall-service')
  .description('Uninstall system service')
  .action(async () => {
    const installer = require('../scripts/install-service');
    await installer.uninstall();
  });

// Default command - start monitoring
program.parse();

// If no command specified, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
