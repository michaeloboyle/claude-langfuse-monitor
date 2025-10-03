// Mock Langfuse SDK to avoid ESM import issues
class Langfuse {
  constructor(config) {
    this.config = config;
    this.traces = [];
    this.generations = [];
  }

  trace(data) {
    this.traces.push(data);
  }

  generation(data) {
    this.generations.push(data);
  }

  async flushAsync() {
    return Promise.resolve();
  }

  async shutdownAsync() {
    return Promise.resolve();
  }
}

module.exports = { Langfuse };
