// Mock @langfuse/client SDK to avoid ESM import issues
class LangfuseClient {
  constructor(config) {
    this.config = config;
    this.api = {
      ingestion: {
        batch: jest.fn().mockResolvedValue({})
      }
    };
  }
}

module.exports = { LangfuseClient };
