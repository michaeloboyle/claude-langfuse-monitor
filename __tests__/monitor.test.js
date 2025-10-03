const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Mock dependencies before requiring Monitor
jest.mock('chokidar');
jest.mock('fs');
jest.mock('os');

const { Monitor } = require('../index');

describe('Monitor', () => {
  let monitor;
  let mockConfig;
  let mockHomedir;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock home directory
    mockHomedir = '/mock/home';
    os.homedir.mockReturnValue(mockHomedir);

    // Mock config file
    mockConfig = {
      host: 'http://localhost:3001',
      publicKey: 'pk-test-123',
      secretKey: 'sk-test-456'
    };

    fs.existsSync.mockImplementation((filepath) => {
      if (filepath.includes('.claude-langfuse/config.json')) {
        return true;
      }
      if (filepath.includes('.claude/projects')) {
        return true;
      }
      return false;
    });

    fs.readFileSync.mockImplementation((filepath) => {
      if (filepath.includes('config.json')) {
        return JSON.stringify(mockConfig);
      }
      return '';
    });

    // Create monitor with dry run to avoid Langfuse initialization
    monitor = new Monitor({ dryRun: true, historyHours: 0 });
  });

  describe('loadConfig', () => {
    test('loads config from file when exists', () => {
      const config = monitor.loadConfig();

      expect(config.host).toBe('http://localhost:3001');
      expect(config.publicKey).toBe('pk-test-123');
      expect(config.secretKey).toBe('sk-test-456');
    });

    test('falls back to environment variables when config file missing', () => {
      fs.existsSync.mockReturnValue(false);
      process.env.LANGFUSE_HOST = 'http://env-host:3001';
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
      process.env.LANGFUSE_SECRET_KEY = 'sk-env';

      const monitor = new Monitor({ dryRun: true });
      const config = monitor.loadConfig();

      expect(config.host).toBe('http://env-host:3001');
      expect(config.publicKey).toBe('pk-env');
      expect(config.secretKey).toBe('sk-env');

      // Cleanup
      delete process.env.LANGFUSE_HOST;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
    });

    test('uses default values when no config or env vars', () => {
      fs.existsSync.mockReturnValue(false);
      const monitor = new Monitor({ dryRun: true });
      const config = monitor.loadConfig();

      expect(config.host).toBe('http://localhost:3001');
      expect(config.publicKey).toBe('');
      expect(config.secretKey).toBe('');
    });
  });

  describe('getClaudeProjectsDir', () => {
    test('returns correct path when directory exists', () => {
      const projectsDir = monitor.getClaudeProjectsDir();
      expect(projectsDir).toBe(path.join(mockHomedir, '.claude', 'projects'));
    });

    test('throws error when directory does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      expect(() => {
        monitor.getClaudeProjectsDir();
      }).toThrow('Claude projects directory not found');
    });
  });

  describe('processMessage', () => {
    test('ignores non-user/assistant message types', () => {
      const entry = { type: 'system', uuid: 'test-uuid' };
      const initialSize = monitor.processedMessages.size;

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      expect(monitor.processedMessages.size).toBe(initialSize);
    });

    test('deduplicates messages by UUID', () => {
      const entry = {
        type: 'user',
        uuid: 'test-uuid-123',
        message: { text: 'Hello' },
        timestamp: new Date().toISOString()
      };

      // Process first time
      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('test-uuid-123')).toBe(true);

      const initialSize = monitor.processedMessages.size;

      // Process second time - should be skipped
      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.size).toBe(initialSize);
    });

    test('extracts text from object message format', () => {
      const entry = {
        type: 'user',
        uuid: 'test-uuid-obj',
        message: { text: 'Hello from object' },
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('test-uuid-obj')).toBe(true);
    });

    test('extracts text from string message format', () => {
      const entry = {
        type: 'user',
        uuid: 'test-uuid-str',
        message: 'Hello from string',
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('test-uuid-str')).toBe(true);
    });

    test('skips messages without UUID', () => {
      const entry = {
        type: 'user',
        message: 'Hello',
        timestamp: new Date().toISOString()
      };

      const initialSize = monitor.processedMessages.size;
      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      expect(monitor.processedMessages.size).toBe(initialSize);
    });

    test('extracts tool_use content blocks', () => {
      const entry = {
        type: 'assistant',
        uuid: 'test-tool-use',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/test.js' } }
          ]
        },
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('test-tool-use')).toBe(true);
    });

    test('extracts tool_result content blocks', () => {
      const entry = {
        type: 'user',
        uuid: 'test-tool-result',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-123', content: 'File contents here' }
          ]
        },
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('test-tool-result')).toBe(true);
    });

    test('extracts mixed content blocks', () => {
      const entry = {
        type: 'assistant',
        uuid: 'test-mixed',
        message: {
          content: [
            { type: 'text', text: 'Let me read that file' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/test.js' } }
          ]
        },
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('test-mixed')).toBe(true);
    });
  });

  describe('processConversationFile', () => {
    test('extracts project path from file location', () => {
      const mockFilepath = path.join(
        mockHomedir,
        '.claude',
        'projects',
        'Users-test-Documents-github-myproject',
        'conversation-123.jsonl'
      );

      const conversationContent = JSON.stringify({
        type: 'user',
        uuid: 'msg-1',
        message: 'Test message',
        timestamp: new Date().toISOString()
      });

      fs.readFileSync.mockReturnValue(conversationContent);

      monitor.processConversationFile(mockFilepath);

      // Should create session ID for this conversation
      expect(monitor.conversationSessions.has(mockFilepath)).toBe(true);
    });

    test('creates consistent session IDs for same conversation', () => {
      const mockFilepath = path.join(
        mockHomedir,
        '.claude',
        'projects',
        'Users-test-Documents-github-myproject',
        'conversation-123.jsonl'
      );

      fs.readFileSync.mockReturnValue('');

      // Process twice
      monitor.processConversationFile(mockFilepath);
      const sessionId1 = monitor.conversationSessions.get(mockFilepath);

      monitor.processConversationFile(mockFilepath);
      const sessionId2 = monitor.conversationSessions.get(mockFilepath);

      expect(sessionId1).toBe(sessionId2);
    });

    test('handles invalid JSON lines gracefully', () => {
      const mockFilepath = path.join(
        mockHomedir,
        '.claude',
        'projects',
        'test-project',
        'conversation.jsonl'
      );

      const invalidContent = 'invalid json\n{"valid": "json"}';
      fs.readFileSync.mockReturnValue(invalidContent);

      // Should not throw
      expect(() => {
        monitor.processConversationFile(mockFilepath);
      }).not.toThrow();
    });

    test('ignores files outside projects structure', () => {
      const mockFilepath = '/random/path/file.jsonl';

      fs.readFileSync.mockReturnValue('{"type": "user"}');

      monitor.processConversationFile(mockFilepath);

      // Should not create session
      expect(monitor.conversationSessions.has(mockFilepath)).toBe(false);
    });
  });

  describe('session ID generation', () => {
    test('generates MD5 hash from project path and conversation ID', () => {
      // The encoded project in the path is decoded by replacing - with /
      const encodedProject = 'Users-test-Documents-github-myproject';
      const decodedProject = encodedProject.replace(/-/g, '/');
      const conversationId = 'conv-abc-123';
      const sessionData = `${decodedProject}:${conversationId}`;

      const expectedHash = crypto.createHash('md5')
        .update(sessionData)
        .digest('hex');

      const mockFilepath = path.join(
        mockHomedir,
        '.claude',
        'projects',
        encodedProject,
        'conv-abc-123.jsonl'
      );

      fs.readFileSync.mockReturnValue('');
      monitor.processConversationFile(mockFilepath);

      const sessionId = monitor.conversationSessions.get(mockFilepath);
      expect(sessionId).toBe(expectedHash);
    });

    test('different conversations get different session IDs', () => {
      const filepath1 = path.join(
        mockHomedir,
        '.claude',
        'projects',
        'project1',
        'conv1.jsonl'
      );

      const filepath2 = path.join(
        mockHomedir,
        '.claude',
        'projects',
        'project2',
        'conv2.jsonl'
      );

      fs.readFileSync.mockReturnValue('');

      monitor.processConversationFile(filepath1);
      monitor.processConversationFile(filepath2);

      const sessionId1 = monitor.conversationSessions.get(filepath1);
      const sessionId2 = monitor.conversationSessions.get(filepath2);

      expect(sessionId1).not.toBe(sessionId2);
    });
  });

  describe('options handling', () => {
    test('sets default options when not provided', () => {
      const m = new Monitor({ dryRun: true });

      expect(m.options.historyHours).toBe(24);
      expect(m.options.daemon).toBe(false);
      expect(m.options.dryRun).toBe(true);
    });

    test('accepts custom historyHours', () => {
      const m = new Monitor({ historyHours: 48, dryRun: true });

      expect(m.options.historyHours).toBe(48);
    });

    test('accepts daemon mode', () => {
      const m = new Monitor({ daemon: true, dryRun: true });

      expect(m.options.daemon).toBe(true);
    });

    test('accepts quiet mode', () => {
      const m = new Monitor({ quiet: true, dryRun: true });

      expect(m.options.quiet).toBe(true);
    });

    test('defaults quiet mode to false', () => {
      const m = new Monitor({ dryRun: true });

      expect(m.options.quiet).toBe(false);
    });
  });

  describe('processedMessages Set', () => {
    test('maintains message deduplication across multiple files', () => {
      const sharedUuid = 'shared-msg-uuid';

      const entry1 = {
        type: 'user',
        uuid: sharedUuid,
        message: 'First occurrence',
        timestamp: new Date().toISOString()
      };

      const entry2 = {
        type: 'user',
        uuid: sharedUuid,
        message: 'Second occurrence',
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry1, 'session-1', '/project1', 'conv1');
      const sizeAfterFirst = monitor.processedMessages.size;

      monitor.processMessage(entry2, 'session-2', '/project2', 'conv2');
      const sizeAfterSecond = monitor.processedMessages.size;

      expect(sizeAfterFirst).toBe(sizeAfterSecond);
    });
  });

  describe('quiet mode', () => {
    let consoleLogSpy;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    test('suppresses per-message logging in quiet mode', () => {
      const quietMonitor = new Monitor({ quiet: true, dryRun: true });

      const entry = {
        type: 'user',
        uuid: 'quiet-test-uuid',
        message: 'Test message',
        timestamp: new Date().toISOString()
      };

      quietMonitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      // Should not log the message preview
      expect(consoleLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Test message')
      );
    });

    test('shows per-message logging when not in quiet mode', () => {
      const verboseMonitor = new Monitor({ quiet: false, dryRun: true });

      const entry = {
        type: 'user',
        uuid: 'verbose-test-uuid',
        message: 'Test message',
        timestamp: new Date().toISOString()
      };

      verboseMonitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      // Should log the message preview
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    test('tracks message counts regardless of quiet mode', () => {
      const quietMonitor = new Monitor({ quiet: true, dryRun: true });

      const userEntry = {
        type: 'user',
        uuid: 'user-msg',
        message: 'User message',
        timestamp: new Date().toISOString()
      };

      const assistantEntry = {
        type: 'assistant',
        uuid: 'assistant-msg',
        message: 'Assistant message',
        timestamp: new Date().toISOString()
      };

      quietMonitor.processMessage(userEntry, 'session-123', '/test/project', 'conv-123');
      quietMonitor.processMessage(assistantEntry, 'session-123', '/test/project', 'conv-123');

      expect(quietMonitor.messageCount.user).toBe(1);
      expect(quietMonitor.messageCount.assistant).toBe(1);
    });
  });
});
