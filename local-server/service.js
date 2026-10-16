const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const domain = require('../miniprogram/services/practice-domain');
const { error, requestId } = require('../miniprogram/services/image-domain');

function sourceFields(value) {
  if (!value || !['math', 'chinese'].includes(value.subject)
    || !Number.isInteger(value.grade) || value.grade < 1 || value.grade > 6
    || !Number.isInteger(value.version) || value.version < 1) {
    throw error('VALIDATION_ERROR', '原题的学科、年级或版本不正确');
  }
  const result = { subject: value.subject, grade: value.grade, version: value.version };
  const limits = { questionText: 5000, questionType: 30, chapter: 100, studentAnswer: 3000,
    correctAnswer: 3000, analysis: 5000, errorReason: 1000, knowledgePoints: 500 };
  Object.entries(limits).forEach(([key, max]) => {
    const text = value[key] === undefined ? '' : value[key];
    if (typeof text !== 'string' || text.length > max || key === 'questionText' && !text.trim()) {
      throw error('VALIDATION_ERROR', '原题字段格式或长度不正确');
    }
    result[key] = text;
  });
  return result;
}

function createService({ adapter, directory }) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'tasks.json');
  const tasks = new Map(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const persist = () => {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Array.from(tasks)), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const publicTask = (task) => {
    const { fingerprint, ...result } = task;
    return JSON.parse(JSON.stringify(result));
  };
  // A restarted process cannot know whether the provider already charged a request.
  tasks.forEach((task) => {
    if (task.status === 'running') Object.assign(task, { status: 'failed', errorCode: 'AI_TASK_INTERRUPTED',
      error: '本地服务已重启，原任务未完成，请确认后重新生成', updatedAt: Date.now() });
  });
  persist();

  async function create(data) {
    const id = requestId(data.requestId);
    const source = sourceFields(data.source);
    const options = domain.generationOptions(data);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ source, options })).digest('hex');
    const previous = tasks.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw error('CONFLICT', '请求编号已用于其他出题内容');
      return publicTask(previous);
    }
    if (!adapter.status().ready) throw error('AI_NOT_CONFIGURED', '请先填写电脑端 AI 配置并重启本地服务');
    const task = { requestId: id, fingerprint, type: 'generation', provider: adapter.provider(),
      status: 'running', createdAt: Date.now(), updatedAt: Date.now() };
    tasks.set(id, task);
    try { persist(); } catch (failure) { tasks.delete(id); throw failure; }
    try {
      const output = await adapter.generate(source, options);
      Object.assign(task, { questions: domain.validateOutput(output, source, options), status: 'completed', updatedAt: Date.now() });
      persist();
    } catch (failure) {
      delete task.questions;
      const allowed = ['AI_NOT_CONFIGURED', 'AI_AUTH_FAILED', 'AI_RATE_LIMITED', 'AI_CONFIG_ERROR',
        'AI_PROVIDER_FAILED', 'AI_TIMEOUT', 'INVALID_AI_OUTPUT', 'UNSUPPORTED_GENERATION'];
      Object.assign(task, { status: 'failed', errorCode: allowed.includes(failure.code) ? failure.code : 'AI_PROVIDER_FAILED',
        error: allowed.includes(failure.code) ? failure.message : '本地出题失败，请检查服务后重试', updatedAt: Date.now() });
      persist();
    }
    return publicTask(task);
  }

  return {
    async call(action, data = {}) {
      if (action === 'generation.config') return adapter.status();
      if (action === 'generation.create') return create(data);
      if (action === 'task.get' && data.type === 'generation') {
        const task = tasks.get(requestId(data.requestId));
        if (!task) throw error('NOT_FOUND', '任务不存在');
        return publicTask(task);
      }
      throw error('NOT_FOUND', '接口不存在');
    }
  };
}

module.exports = { createService, sourceFields };
