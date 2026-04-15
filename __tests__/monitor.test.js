const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Mock dependencies before requiring Monitor
jest.mock('chokidar');
jest.mock('fs');
jest.mock('os');

const { Monitor, runMain } = require('../index');

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

    test('loads userId from config file when present', () => {
      mockConfig.userId = 'test@example.com';
      const config = monitor.loadConfig();

      expect(config.userId).toBe('test@example.com');
    });

    test('userId is undefined when not in config file', () => {
      const config = monitor.loadConfig();

      expect(config.userId).toBeUndefined();
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

    test('preserves historyHours: 0 (does not fall back to default)', () => {
      const m = new Monitor({ historyHours: 0, dryRun: true });

      expect(m.options.historyHours).toBe(0);
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

  describe('userId configuration', () => {
    test('uses userId from config in user traces', () => {
      mockConfig.userId = 'configured@example.com';
      const m = new Monitor({ dryRun: false });

      const entry = {
        type: 'user',
        uuid: 'userid-test-uuid',
        message: 'Hello',
        timestamp: new Date().toISOString()
      };

      m.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      const traceEvents = m.pendingEvents.filter(e => e.type === 'trace-create');
      expect(traceEvents).toHaveLength(1);
      expect(traceEvents[0].body.userId).toBe('configured@example.com');
    });

    test('falls back to user@id.not.set when no userId in config', () => {
      // mockConfig has no userId
      const m = new Monitor({ dryRun: false });

      const entry = {
        type: 'user',
        uuid: 'fallback-userid-uuid',
        message: 'Hello',
        timestamp: new Date().toISOString()
      };

      m.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      const traceEvents = m.pendingEvents.filter(e => e.type === 'trace-create');
      expect(traceEvents).toHaveLength(1);
      expect(traceEvents[0].body.userId).toBe('user@id.not.set');
    });
  });

  describe('tool observations', () => {
    test('creates span-create with type tool when tool_result arrives with matching id', () => {
      const m = new Monitor({ dryRun: false });

      const assistantEntry = {
        type: 'assistant',
        uuid: 'tool-obs-uuid',
        parentUuid: 'parent-uuid',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-call-1', name: 'Read', input: { file_path: '/test.js' } }
          ]
        },
        timestamp: new Date().toISOString()
      };

      const userEntry = {
        type: 'user',
        uuid: 'tool-result-uuid',
        parentUuid: 'tool-obs-uuid',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-call-1', content: 'file contents here', is_error: false }
          ]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(assistantEntry, 'session-123', '/test/project', 'conv-123');
      // tool_use is buffered — no span yet
      expect(m.pendingEvents.filter(e => e.type === 'span-create')).toHaveLength(0);
      expect(m.pendingToolSpans.has('tool-call-1')).toBe(true);

      m.processMessage(userEntry, 'session-123', '/test/project', 'conv-123');
      // now merged span should be in pendingEvents
      const spanEvents = m.pendingEvents.filter(e => e.type === 'span-create');
      expect(spanEvents).toHaveLength(1);
      expect(spanEvents[0].body.type).toBe('tool');
      expect(spanEvents[0].body.name).toBe('Read');
      expect(spanEvents[0].body.input).toEqual({ file_path: '/test.js' });
      expect(spanEvents[0].body.output).toBe('file contents here');
      expect(spanEvents[0].body.is_error).toBe(false);
      expect(spanEvents[0].body.id).toBe('tool-call-1');
      expect(spanEvents[0].body.traceId).toBe('parent-uuid');
      expect(spanEvents[0].body.parentObservationId).toBe('tool-obs-uuid');
      expect(m.pendingToolSpans.has('tool-call-1')).toBe(false);
    });

    test('tool_use blocks do not appear in generation output text', () => {
      const m = new Monitor({ dryRun: false });

      const entry = {
        type: 'assistant',
        uuid: 'tool-text-uuid',
        parentUuid: 'parent-uuid',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-call-2', name: 'Bash', input: { command: 'ls' } }
          ]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      const genEvents = m.pendingEvents.filter(e => e.type === 'generation-create');
      expect(genEvents).toHaveLength(1);
      expect(genEvents[0].body.output).toBe('');
    });

    test('mixed content creates generation for text and spans for tool_use', () => {
      const m = new Monitor({ dryRun: false });

      const assistantEntry = {
        type: 'assistant',
        uuid: 'mixed-uuid',
        parentUuid: 'parent-uuid',
        message: {
          content: [
            { type: 'text', text: 'Let me read that file' },
            { type: 'tool_use', id: 'tool-call-3', name: 'Read', input: { file_path: '/test.js' } },
            { type: 'tool_use', id: 'tool-call-4', name: 'Bash', input: { command: 'ls' } }
          ]
        },
        timestamp: new Date().toISOString()
      };

      const userEntry = {
        type: 'user',
        uuid: 'mixed-result-uuid',
        parentUuid: 'mixed-uuid',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-call-3', content: 'const x = 1;', is_error: false },
            { type: 'tool_result', tool_use_id: 'tool-call-4', content: 'file1.js\nfile2.js', is_error: false }
          ]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(assistantEntry, 'session-123', '/test/project', 'conv-123');
      m.processMessage(userEntry, 'session-123', '/test/project', 'conv-123');

      const genEvents = m.pendingEvents.filter(e => e.type === 'generation-create');
      expect(genEvents).toHaveLength(1);
      expect(genEvents[0].body.output).toBe('Let me read that file');

      const spanEvents = m.pendingEvents.filter(e => e.type === 'span-create');
      expect(spanEvents).toHaveLength(2);
      expect(spanEvents[0].body.name).toBe('Read');
      expect(spanEvents[0].body.output).toBe('const x = 1;');
      expect(spanEvents[1].body.name).toBe('Bash');
      expect(spanEvents[1].body.output).toBe('file1.js\nfile2.js');
    });

    test('unmatched tool_use spans are buffered in pendingToolSpans until flush', () => {
      const m = new Monitor({ dryRun: false });

      const entry = {
        type: 'assistant',
        uuid: 'no-id-tool-uuid',
        parentUuid: 'parent-uuid',
        message: {
          content: [
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.js' } }
          ]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      // No span-create yet — buffered waiting for tool_result
      const spanEvents = m.pendingEvents.filter(e => e.type === 'span-create');
      expect(spanEvents).toHaveLength(0);
      // Buffered in pendingToolSpans (key is undefined since no id on tool_use)
      expect(m.pendingToolSpans.size).toBe(1);
    });
  });

  describe('dynamic model from entry', () => {
    test('uses model from entry.message.model in assistant generations', () => {
      const m = new Monitor({ dryRun: false });

      const entry = {
        type: 'assistant',
        uuid: 'model-test-uuid',
        parentUuid: 'parent-uuid',
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Response text' }]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      const genEvents = m.pendingEvents.filter(e => e.type === 'generation-create');
      expect(genEvents).toHaveLength(1);
      expect(genEvents[0].body.model).toBe('claude-opus-4-6');
    });

    test('model is undefined when not present on entry.message', () => {
      const m = new Monitor({ dryRun: false });

      const entry = {
        type: 'assistant',
        uuid: 'no-model-uuid',
        parentUuid: 'parent-uuid',
        message: {
          content: [{ type: 'text', text: 'Response text' }]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      const genEvents = m.pendingEvents.filter(e => e.type === 'generation-create');
      expect(genEvents).toHaveLength(1);
      expect(genEvents[0].body.model).toBeUndefined();
    });
  });

  describe('processMessage - edge cases for branch coverage', () => {
    test('block.text falsy returns empty string for text block', () => {
      // Covers binary-expr `block.text || ''` false branch (block.text is undefined)
      const entry = {
        type: 'user',
        uuid: 'text-block-no-text',
        message: {
          content: [
            { type: 'text' } // no text property → block.text is undefined
          ]
        },
        timestamp: new Date().toISOString()
      };
      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('text-block-no-text')).toBe(true);
    });

    test('tool_result with null content returns empty string', () => {
      // Covers `block.content || ''` false branch
      const entry = {
        type: 'user',
        uuid: 'tool-result-null-content',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-x', content: null }
          ]
        },
        timestamp: new Date().toISOString()
      };
      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('tool-result-null-content')).toBe(true);
    });

    test('message that is neither object nor string falls through both branches', () => {
      // Covers `else if (typeof entry.message === 'string')` false branch
      const entry = {
        type: 'user',
        uuid: 'null-message-uuid',
        message: null, // not object (falsy), not string
        timestamp: new Date().toISOString()
      };
      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('null-message-uuid')).toBe(true);
    });

    test('entry without timestamp uses Date.now() fallback', () => {
      // Covers `entry.timestamp || Date.now()` false branch
      const entry = {
        type: 'user',
        uuid: 'no-timestamp-uuid',
        message: 'Hello'
        // no timestamp field
      };
      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('no-timestamp-uuid')).toBe(true);
    });

    test('tool_result with unmatched tool_use_id skips span creation', () => {
      // Covers `if (pending)` false branch - no pending span matches the tool_use_id
      const m = new Monitor({ dryRun: false });
      const entry = {
        type: 'user',
        uuid: 'unmatched-result-uuid',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'nonexistent-id', content: 'result' }
          ]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(entry, 'session-123', '/test/project', 'conv-123');

      // No span should be created since there's no matching pending tool_use
      const spanEvents = m.pendingEvents.filter(e => e.type === 'span-create');
      expect(spanEvents).toHaveLength(0);
    });

    test('tool_use without id matched with tool_result uses randomUUID', () => {
      // Covers `pending.toolCall.id || crypto.randomUUID()` false branch
      const m = new Monitor({ dryRun: false });

      // Process assistant message with tool_use that has no id
      const assistantEntry = {
        type: 'assistant',
        uuid: 'no-id-assistant-uuid',
        parentUuid: 'parent-uuid',
        message: {
          content: [
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.js' } } // no id
          ]
        },
        timestamp: new Date().toISOString()
      };

      // Process user message with tool_result with no tool_use_id
      const userEntry = {
        type: 'user',
        uuid: 'no-id-result-uuid',
        message: {
          content: [
            { type: 'tool_result', content: 'match via undefined key' } // no tool_use_id
          ]
        },
        timestamp: new Date().toISOString()
      };

      m.processMessage(assistantEntry, 'session-123', '/test/project', 'conv-123');
      m.processMessage(userEntry, 'session-123', '/test/project', 'conv-123');

      const spanEvents = m.pendingEvents.filter(e => e.type === 'span-create');
      expect(spanEvents).toHaveLength(1);
      // id should be a generated UUID (not undefined)
      expect(typeof spanEvents[0].body.id).toBe('string');
      expect(spanEvents[0].body.id).toBeTruthy();
    });
  });

  describe('processMessage - array tool_result content', () => {
    test('extracts array content from tool_result blocks', () => {
      const entry = {
        type: 'user',
        uuid: 'array-tool-result-uuid',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-123',
              content: [
                { type: 'text', text: 'Part 1' },
                { type: 'text', text: 'Part 2' }
              ]
            }
          ]
        },
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('array-tool-result-uuid')).toBe(true);
    });

    test('returns empty string for unknown block types', () => {
      const entry = {
        type: 'user',
        uuid: 'unknown-block-uuid',
        message: {
          content: [
            { type: 'unknown_type', data: 'irrelevant' }
          ]
        },
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('unknown-block-uuid')).toBe(true);
    });

    test('handles array tool_result with non-text items', () => {
      const entry = {
        type: 'user',
        uuid: 'array-tool-result-mixed',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-456',
              content: [
                { type: 'text', text: 'text item' },
                'plain string item'
              ]
            }
          ]
        },
        timestamp: new Date().toISOString()
      };

      monitor.processMessage(entry, 'session-123', '/test/project', 'conv-123');
      expect(monitor.processedMessages.has('array-tool-result-mixed')).toBe(true);
    });
  });

  describe('processConversationFile - error handling', () => {
    test('logs error when file read fails', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const mockFilepath = path.join(
        mockHomedir, '.claude', 'projects', 'test-project', 'conversation.jsonl'
      );

      fs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(() => {
        monitor.processConversationFile(mockFilepath);
      }).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('flushPendingEvents', () => {
    test('returns early when no langfuse client (dryRun mode)', async () => {
      const m = new Monitor({ dryRun: true });
      m.pendingEvents.push({ type: 'trace-create', body: {} });

      await m.flushPendingEvents();

      // Events not flushed because langfuse is null
      expect(m.pendingEvents).toHaveLength(1);
    });

    test('returns early when no pending events', async () => {
      const m = new Monitor({ dryRun: false });

      await m.flushPendingEvents();

      expect(m.langfuse.api.ingestion.batch).not.toHaveBeenCalled();
    });

    test('flushes pending events via batch API', async () => {
      const m = new Monitor({ dryRun: false });
      m.pendingEvents.push({
        type: 'trace-create',
        id: 'event-1',
        timestamp: new Date().toISOString(),
        body: { id: 'trace-1', name: 'test' }
      });

      await m.flushPendingEvents();

      expect(m.langfuse.api.ingestion.batch).toHaveBeenCalledWith({
        batch: expect.arrayContaining([
          expect.objectContaining({ type: 'trace-create' })
        ])
      });
      expect(m.pendingEvents).toHaveLength(0);
    });

    test('emits unmatched tool spans as span-create events on flush', async () => {
      const m = new Monitor({ dryRun: false });

      m.pendingToolSpans.set('unmatched-id', {
        toolCall: { id: 'unmatched-id', name: 'Glob', input: { pattern: '**/*.js' } },
        traceId: 'trace-abc',
        parentObservationId: 'obs-abc',
        timestamp: new Date(),
        project: '/test/project',
        conversationId: 'conv-1',
        eventTimestamp: new Date().toISOString()
      });

      await m.flushPendingEvents();

      expect(m.langfuse.api.ingestion.batch).toHaveBeenCalled();
      expect(m.pendingToolSpans.size).toBe(0);

      const batchArg = m.langfuse.api.ingestion.batch.mock.calls[0][0];
      const spanEvent = batchArg.batch.find(e => e.type === 'span-create');
      expect(spanEvent).toBeDefined();
      expect(spanEvent.body.name).toBe('Glob');
      expect(spanEvent.body.type).toBe('tool');
    });

    test('emits unmatched tool span without id using random UUID', async () => {
      const m = new Monitor({ dryRun: false });

      m.pendingToolSpans.set(undefined, {
        toolCall: { name: 'Read', input: { file_path: '/test.js' } }, // no id
        traceId: 'trace-xyz',
        parentObservationId: 'obs-xyz',
        timestamp: new Date(),
        project: '/test/project',
        conversationId: 'conv-2',
        eventTimestamp: new Date().toISOString()
      });

      await m.flushPendingEvents();

      const batchArg = m.langfuse.api.ingestion.batch.mock.calls[0][0];
      const spanEvent = batchArg.batch.find(e => e.type === 'span-create');
      expect(spanEvent).toBeDefined();
      expect(spanEvent.body.id).toBeDefined();
    });

    test('handles API errors gracefully', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const m = new Monitor({ dryRun: false });
      m.langfuse.api.ingestion.batch.mockRejectedValueOnce(new Error('Network error'));
      m.pendingEvents.push({ type: 'trace-create', body: {} });

      await expect(m.flushPendingEvents()).resolves.not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    test('auto-flushes when pendingEvents reaches 10', async () => {
      const m = new Monitor({ dryRun: false });
      const flushSpy = jest.spyOn(m, 'flushPendingEvents').mockResolvedValue();

      for (let i = 0; i < 10; i++) {
        m.processMessage({
          type: 'user',
          uuid: `batch-msg-${i}`,
          message: 'Hello',
          timestamp: new Date().toISOString()
        }, 'session-123', '/test/project', 'conv-123');
      }

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('checkStatus', () => {
    let consoleLogSpy;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    test('shows success status when fully configured', async () => {
      const m = new Monitor({ dryRun: true });

      await m.checkStatus();

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Claude projects directory found');
      expect(output).toContain('Langfuse credentials configured');
      expect(output).toContain('Monitor ready to run');
    });

    test('shows error and returns early when claude directory not found', async () => {
      fs.existsSync.mockImplementation((filepath) => {
        if (filepath.includes('.claude-langfuse/config.json')) return true;
        if (filepath.includes('.claude/projects')) return false;
        return false;
      });

      const m = new Monitor({ dryRun: true });

      await m.checkStatus();

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Claude projects directory not found');
      expect(output).not.toContain('Monitor ready to run');
    });

    test('shows error and returns early when credentials not configured', async () => {
      mockConfig.publicKey = '';
      mockConfig.secretKey = '';

      const m = new Monitor({ dryRun: true });

      await m.checkStatus();

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Langfuse credentials not configured');
      expect(output).not.toContain('Monitor ready to run');
    });
  });

  describe('start', () => {
    let mockWatcher;
    let consoleLogSpy;

    beforeEach(() => {
      mockWatcher = {
        on: jest.fn().mockReturnThis(),
        close: jest.fn().mockResolvedValue(undefined)
      };
      const chokidar = require('chokidar');
      chokidar.watch.mockReturnValue(mockWatcher);
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      // Prevent processExistingHistory from failing when historyHours defaults to 24
      fs.readdirSync.mockReturnValue([]);
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
      process.removeAllListeners('SIGINT');
    });

    test('sets up file watcher with change and add handlers', async () => {
      const chokidar = require('chokidar');
      const m = new Monitor({ dryRun: true, historyHours: 0 });

      m.start();
      await new Promise(resolve => setImmediate(resolve));

      expect(chokidar.watch).toHaveBeenCalled();
      expect(mockWatcher.on).toHaveBeenCalledWith('change', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('add', expect.any(Function));
    });

    test('calls processExistingHistory when historyHours > 0', async () => {
      fs.readdirSync.mockReturnValue([]);
      const m = new Monitor({ dryRun: true, historyHours: 1 });
      const historySpy = jest.spyOn(m, 'processExistingHistory').mockResolvedValue();

      m.start();
      await new Promise(resolve => setImmediate(resolve));

      expect(historySpy).toHaveBeenCalled();
    });

    test('skips processExistingHistory when historyHours is 0', async () => {
      const m = new Monitor({ dryRun: true, historyHours: 0 });
      const historySpy = jest.spyOn(m, 'processExistingHistory').mockResolvedValue();

      m.start();
      await new Promise(resolve => setImmediate(resolve));

      expect(historySpy).not.toHaveBeenCalled();
    });

    test('skips processExistingHistory when historyHours is negative', async () => {
      const m = new Monitor({ dryRun: true, historyHours: -1 });
      const historySpy = jest.spyOn(m, 'processExistingHistory').mockResolvedValue();

      m.start();
      await new Promise(resolve => setImmediate(resolve));

      expect(historySpy).not.toHaveBeenCalled();
    });

    test('change event triggers processConversationFile', async () => {
      const m = new Monitor({ dryRun: true, historyHours: 0 });
      const processFileSpy = jest.spyOn(m, 'processConversationFile').mockImplementation();

      m.start();
      await new Promise(resolve => setImmediate(resolve));

      const changeHandler = mockWatcher.on.mock.calls.find(c => c[0] === 'change')[1];
      changeHandler('/path/to/file.jsonl');

      expect(processFileSpy).toHaveBeenCalledWith('/path/to/file.jsonl');
    });

    test('add event triggers processConversationFile', async () => {
      const m = new Monitor({ dryRun: true, historyHours: 0 });
      const processFileSpy = jest.spyOn(m, 'processConversationFile').mockImplementation();

      m.start();
      await new Promise(resolve => setImmediate(resolve));

      const addHandler = mockWatcher.on.mock.calls.find(c => c[0] === 'add')[1];
      addHandler('/path/to/new-file.jsonl');

      expect(processFileSpy).toHaveBeenCalledWith('/path/to/new-file.jsonl');
    });

    test('SIGINT handler closes watcher, flushes events, and exits', async () => {
      const processExitSpy = jest.spyOn(process, 'exit').mockImplementation();
      process.removeAllListeners('SIGINT');

      const m = new Monitor({ dryRun: true, historyHours: 0 });
      const flushSpy = jest.spyOn(m, 'flushPendingEvents').mockResolvedValue();

      m.start();
      await new Promise(resolve => setImmediate(resolve));

      process.emit('SIGINT');
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(flushSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);

      processExitSpy.mockRestore();
    });
  });

  describe('processExistingHistory', () => {
    let consoleLogSpy;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    test('finds and processes recent conversation files recursively', async () => {
      const projectsDir = path.join(mockHomedir, '.claude', 'projects');
      const subDir = path.join(projectsDir, 'myproject');

      fs.readdirSync.mockImplementation((dir) => {
        if (dir === projectsDir) {
          return [{ name: 'myproject', isDirectory: () => true }];
        }
        if (dir === subDir) {
          return [{ name: 'conv.jsonl', isDirectory: () => false }];
        }
        return [];
      });
      fs.statSync.mockReturnValue({ mtimeMs: Date.now() });
      fs.readFileSync.mockReturnValue('');

      await monitor.processExistingHistory();

      const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('1 recent conversations');
    });

    test('skips files older than the historyHours cutoff', async () => {
      const projectsDir = path.join(mockHomedir, '.claude', 'projects');
      const subDir = path.join(projectsDir, 'oldproject');

      fs.readdirSync.mockImplementation((dir) => {
        if (dir === projectsDir) {
          return [{ name: 'oldproject', isDirectory: () => true }];
        }
        if (dir === subDir) {
          return [{ name: 'conv.jsonl', isDirectory: () => false }];
        }
        return [];
      });
      fs.statSync.mockReturnValue({ mtimeMs: 0 }); // very old

      const processFileSpy = jest.spyOn(monitor, 'processConversationFile').mockImplementation();

      await monitor.processExistingHistory();

      expect(processFileSpy).not.toHaveBeenCalled();
    });

    test('ignores non-jsonl files in project directories', async () => {
      const projectsDir = path.join(mockHomedir, '.claude', 'projects');

      fs.readdirSync.mockImplementation((dir) => {
        if (dir === projectsDir) {
          return [{ name: 'config.json', isDirectory: () => false }];
        }
        return [];
      });

      const processFileSpy = jest.spyOn(monitor, 'processConversationFile').mockImplementation();

      await monitor.processExistingHistory();

      expect(processFileSpy).not.toHaveBeenCalled();
    });
  });

  describe('runMain', () => {
    test('starts the monitor successfully', async () => {
      const startSpy = jest.spyOn(Monitor.prototype, 'start')
        .mockReturnValue(new Promise(() => {}));

      runMain();

      expect(startSpy).toHaveBeenCalled();

      startSpy.mockRestore();
    });

    test('logs error and exits when start throws', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const processExitSpy = jest.spyOn(process, 'exit').mockImplementation();

      const startSpy = jest.spyOn(Monitor.prototype, 'start')
        .mockRejectedValue(new Error('Startup failure'));

      runMain();

      await new Promise(resolve => setImmediate(resolve));

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);

      startSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
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
