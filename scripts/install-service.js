#!/usr/bin/env node

/**
 * Service Installation Script
 *
 * Installs claude-langfuse-monitor as a system service that
 * starts automatically on login.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const chalk = require('chalk');

const PLIST_NAME = 'co.oboyle.claude-langfuse-monitor.plist';

function getPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
}

function getNodePath() {
  try {
    return execSync('which node').toString().trim();
  } catch (error) {
    return '/usr/local/bin/node';
  }
}

function getScriptPath() {
  // Get the installed package location
  const globalNodeModules = execSync('npm root -g').toString().trim();
  const packagePath = path.join(globalNodeModules, 'claude-langfuse-monitor');

  if (fs.existsSync(packagePath)) {
    return path.join(packagePath, 'index.js');
  }

  // Fall back to local development path
  return path.join(__dirname, '..', 'index.js');
}

function getConfigPath() {
  return path.join(os.homedir(), '.claude-langfuse', 'config.json');
}

function createPlist() {
  const nodePath = getNodePath();
  const scriptPath = getScriptPath();
  const logDir = path.join(os.homedir(), 'Library', 'Logs');
  const logFile = path.join(logDir, 'claude-langfuse-monitor.log');
  const errorLogFile = path.join(logDir, 'claude-langfuse-monitor-error.log');

  // Ensure log directory exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>co.oboyle.claude-langfuse-monitor</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${logFile}</string>

    <key>StandardErrorPath</key>
    <string>${errorLogFile}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${os.homedir()}</string>

    <key>ThrottleInterval</key>
    <integer>60</integer>
</dict>
</plist>`;

  return plist;
}

async function install() {
  console.log(chalk.cyan('🔧 Installing Claude Langfuse Monitor as System Service'));
  console.log(chalk.cyan('='.repeat(60)));

  // Check platform
  if (os.platform() !== 'darwin') {
    console.log(chalk.yellow('⚠️  Currently only macOS (launchd) is supported'));
    console.log(chalk.gray('   Linux systemd support coming soon'));
    return;
  }

  // Check configuration
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    console.log(chalk.red('❌ Configuration not found'));
    console.log(chalk.yellow('   Run: claude-langfuse config --public-key <key> --secret-key <key>'));
    return;
  }

  // Create LaunchAgent directory if needed
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Generate and write plist
  const plistPath = getPlistPath();
  const plistContent = createPlist();

  fs.writeFileSync(plistPath, plistContent);
  console.log(chalk.green('✅ Service configuration created'));
  console.log(chalk.gray(`   ${plistPath}`));

  // Load the service
  try {
    execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
    execSync(`launchctl load ${plistPath}`);
    console.log(chalk.green('✅ Service loaded and started'));
  } catch (error) {
    console.log(chalk.red('❌ Failed to load service'));
    console.log(chalk.gray(`   Error: ${error.message}`));
    return;
  }

  // Show status
  console.log(chalk.cyan('\n📊 Service Status:'));
  console.log(chalk.gray('   The monitor will now start automatically on login'));
  console.log(chalk.gray(`   Logs: ~/Library/Logs/claude-langfuse-monitor.log`));

  console.log(chalk.cyan('\n💡 Useful Commands:'));
  console.log(chalk.gray(`   View logs:    tail -f ~/Library/Logs/claude-langfuse-monitor.log`));
  console.log(chalk.gray(`   Stop service: launchctl stop co.oboyle.claude-langfuse-monitor`));
  console.log(chalk.gray(`   Uninstall:    claude-langfuse uninstall-service`));
}

async function uninstall() {
  console.log(chalk.cyan('🗑️  Uninstalling Claude Langfuse Monitor Service'));
  console.log(chalk.cyan('='.repeat(60)));

  const plistPath = getPlistPath();

  if (!fs.existsSync(plistPath)) {
    console.log(chalk.yellow('⚠️  Service not installed'));
    return;
  }

  // Unload the service
  try {
    execSync(`launchctl unload ${plistPath}`);
    console.log(chalk.green('✅ Service stopped'));
  } catch (error) {
    console.log(chalk.yellow('⚠️  Service was not running'));
  }

  // Remove plist file
  fs.unlinkSync(plistPath);
  console.log(chalk.green('✅ Service removed'));

  console.log(chalk.gray('\n💡 Configuration and logs are preserved'));
  console.log(chalk.gray('   To remove completely:'));
  console.log(chalk.gray('   rm -rf ~/.claude-langfuse'));
  console.log(chalk.gray('   rm ~/Library/Logs/claude-langfuse-monitor*.log'));
}

module.exports = { install, uninstall };

// If run directly
if (require.main === module) {
  const action = process.argv[2];

  if (action === 'uninstall') {
    uninstall();
  } else {
    install();
  }
}
