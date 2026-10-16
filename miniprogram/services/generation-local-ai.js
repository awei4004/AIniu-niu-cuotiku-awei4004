const storage = require('../utils/storage');
const config = require('../config/env');
const domain = require('./practice-domain');
const { error, requestId: validateRequestId } = require('./image-domain');

function request(baseUrl, action, data = {}) {
  return new Promise((resolve, reject) => {
    wx.request({ url: `${baseUrl.replace(/\/$/, '')}/api`, method: 'POST', data: { action, data },
      header: { 'content-type': 'application/json' }, timeout: 75000,
      success(response) {
        const body = response.data;
        if (body && body.ok === false && body.error) {
          reject(error(body.error.code, body.error.message));
        } else if (response.statusCode === 200 && body && body.ok === true && body.data) resolve(body.data);
        else reject(error('LOCAL_AI_UNREACHABLE', '本地 AI 服务响应异常，请检查电脑端服务'));
      },
      fail() { reject(error('LOCAL_AI_UNREACHABLE', '无法连接本地 AI 服务，请确认电脑端服务已启动及开发工具网络设置')); }
    });
  });
}

function findTask(user, data) {
  return storage.getTasks().find((item) => item.ownerId === user._id && item.type === 'generation'
    && (data.taskId ? item._id === data.taskId : item.requestId === data.requestId));
}

function sourceFor(user, id) {
  const source = storage.getQuestions().find((item) => item._id === id && item.ownerId === user._id && !item.deletedAt);
  if (!source || storage.ensureUser()._id !== user._id) throw error('NOT_FOUND', '错题不存在');
  return source;
}

function update(task, changes) {
  const result = Object.assign({}, task, changes, { updatedAt: Date.now() });
  storage.saveTasks(storage.getTasks().map((item) => item._id === task._id ? result : item));
  return result;
}

function importTask(user, task, remote) {
  if (!remote || remote.requestId !== task.requestId || !['running', 'completed', 'failed'].includes(remote.status)) {
    throw error('LOCAL_AI_UNREACHABLE', '本地 AI 任务响应异常，请查询原任务');
  }
  if (remote.status === 'running') return task;
  if (remote.status === 'failed') return update(task, { status: 'failed', errorCode: remote.errorCode,
    error: remote.error || 'AI 出题失败' });
  try {
    const source = sourceFor(user, task.sourceQuestionId);
    domain.checkSource(task, source);
    const fields = domain.validateOutput({ sourceVersion: task.sourceVersion, questions: remote.questions }, source, task.options);
    const generated = fields.map((item, index) => Object.assign({}, item, {
      _id: `localai_${task._id}_${index}`, ownerId: user._id, studentId: source.studentId,
      grade: source.grade, subject: source.subject, sourceQuestionId: source._id,
      sourceQuestionUpdatedAt: source.updatedAt, sourceVersion: task.sourceVersion, taskId: task._id,
      provider: remote.provider, status: 'draft', version: 1, createdAt: Date.now(), updatedAt: Date.now()
    }));
    const existing = storage.getGeneratedQuestions();
    // Stable IDs make recovery safe if saving questions succeeded but saving the task failed.
    storage.saveGeneratedQuestions(generated.filter((item) => !existing.some((old) => old._id === item._id)).concat(existing));
    return update(task, { status: 'completed', provider: remote.provider, generatedQuestionIds: generated.map((item) => item._id) });
  } catch (failure) {
    if (['NOT_FOUND', 'SOURCE_CHANGED', 'INVALID_AI_OUTPUT'].includes(failure.code)) {
      update(task, { status: 'failed', errorCode: failure.code, error: failure.message });
    }
    throw failure;
  }
}

async function getTask(user, data) {
  const task = findTask(user, data);
  if (!task) throw error('NOT_FOUND', '任务不存在');
  if (task.status !== 'running') return task;
  return importTask(user, task, await request(task.serverUrl, 'task.get', { type: 'generation', requestId: task.requestId }));
}

async function create(user, data) {
  const source = sourceFor(user, data.sourceQuestionId);
  const options = domain.generationOptions(Object.assign({ difficulty: source.difficulty }, data));
  const requestId = data.requestId === undefined ? storage.makeId('generation') : validateRequestId(data.requestId);
  let task = findTask(user, { requestId });
  if (task) {
    if (task.backend !== 'local-http' || task.sourceQuestionId !== source._id
      || task.sourceVersion !== domain.sourceVersion(source)
      || JSON.stringify(task.options) !== JSON.stringify(options)) throw error('CONFLICT', '请求编号已用于其他出题内容');
  } else {
    task = { _id: storage.makeId('task'), ownerId: user._id, studentId: source.studentId,
      sourceQuestionId: source._id, sourceVersion: domain.sourceVersion(source), options, requestId,
      type: 'generation', backend: 'local-http', serverUrl: config.localAiBaseUrl,
      provider: 'openai-compatible', status: 'running', createdAt: Date.now() };
    storage.saveTasks([task].concat(storage.getTasks()));
  }
  if (task.status === 'running') {
    const teaching = { version: source.version || 1 };
    ['subject', 'grade', 'questionText', 'questionType', 'chapter', 'studentAnswer', 'correctAnswer',
      'analysis', 'errorReason', 'knowledgePoints'].forEach((key) => { if (source[key] !== undefined) teaching[key] = source[key]; });
    try {
      const remote = await request(task.serverUrl, 'generation.create', Object.assign({ source: teaching, requestId }, options));
      task = importTask(user, task, remote);
    } catch (failure) {
      if (['AI_NOT_CONFIGURED', 'VALIDATION_ERROR', 'CONFLICT'].includes(failure.code)) {
        update(task, { status: 'failed', errorCode: failure.code, error: failure.message });
      }
      throw failure;
    }
  }
  if (task.status === 'failed') throw error(task.errorCode, task.error);
  if (task.status === 'running') throw error('GENERATION_RUNNING', '出题仍在进行，请查询原任务');
  return storage.getGeneratedQuestions().filter((item) => item.ownerId === user._id
    && item.taskId === task._id && item.status !== 'deleted');
}

module.exports = { enabled: () => Boolean(config.localAiBaseUrl), create, getTask, findTask,
  status: () => request(config.localAiBaseUrl, 'generation.config') };
