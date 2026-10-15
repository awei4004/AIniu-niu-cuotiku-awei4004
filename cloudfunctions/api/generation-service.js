const crypto = require('crypto');
const domain = require('./practice-domain');
const { error, requestId: validateRequestId } = require('./image-domain');
const TASK_TIMEOUT = 90000;
const idFor = (owner, request) => crypto.createHash('sha256').update(JSON.stringify([owner, 'generation', request])).digest('hex');

function createService({ db, adapter, getSource, publicMessage }) {
  async function expire(task) {
    if (task.status !== 'running' || task.deadlineAt > Date.now()) return task;
    return db.runTransaction(async (transaction) => {
      const { data: current } = await transaction.collection('tasks').doc(task._id).get();
      if (current.status !== 'running') return current;
      const changes = { status: 'failed', errorCode: 'AI_TIMEOUT', error: '出题任务超时，请重新生成', updatedAt: Date.now() };
      await transaction.collection('tasks').doc(task._id).update({ data: changes });
      return Object.assign({}, current, changes);
    });
  }

  async function getTask(user, data) {
    const id = data.taskId || idFor(user._id, validateRequestId(data.requestId));
    if (typeof id !== 'string' || !id) throw error('NOT_FOUND', '任务不存在');
    const { data: task } = await db.collection('tasks').doc(id).get();
    if (!task || task.ownerId !== user._id || task.type !== 'generation') throw error('NOT_FOUND', '任务不存在');
    return expire(task);
  }

  async function previous(task) {
    task = await expire(task);
    if (task.status === 'running') throw error('GENERATION_RUNNING', '出题仍在进行，请查询原任务');
    if (task.status === 'failed') throw error(task.errorCode || 'AI_PROVIDER_FAILED', task.error);
    const results = await Promise.all(task.generatedQuestionIds.map(async (id) => {
      const { data: item } = await db.collection('generated_questions').doc(id).get();
      return item;
    }));
    return results.filter((item) => item && item.ownerId === task.ownerId && item.status !== 'deleted');
  }

  async function create(user, data) {
    const source = await getSource(user, data.sourceQuestionId);
    const options = domain.generationOptions(Object.assign({ difficulty: source.difficulty }, data));
    const requestId = data.requestId === undefined ? crypto.randomBytes(16).toString('hex') : validateRequestId(data.requestId);
    const id = idFor(user._id, requestId);
    const sourceVersion = domain.sourceVersion(source);
    const claim = await db.runTransaction(async (transaction) => {
      const { data: existing } = await transaction.collection('tasks').doc(id).get();
      if (existing) {
        if (existing.sourceQuestionId !== source._id || existing.sourceVersion !== sourceVersion
          || JSON.stringify(existing.options) !== JSON.stringify(options)) throw error('CONFLICT', '请求编号已用于其他出题内容');
        return { task: existing, fresh: false };
      }
      const task = { _id: id, ownerId: user._id, studentId: source.studentId, sourceQuestionId: source._id,
        sourceVersion, options, requestId, type: 'generation', provider: adapter.provider(), status: 'running',
        createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now() + TASK_TIMEOUT };
      const { _id, ...document } = task;
      await transaction.collection('tasks').doc(_id).set({ data: document });
      return { task, fresh: true };
    });
    if (!claim.fresh) return previous(claim.task);
    const task = claim.task;
    try {
      const raw = await adapter.generate(source, options);
      const generated = domain.validateOutput(raw, source, options);
      const results = generated.map((item) => Object.assign({}, item, {
        _id: `generated_${crypto.randomBytes(12).toString('hex')}`,
        ownerId: user._id, studentId: source.studentId, grade: source.grade, subject: source.subject,
        sourceQuestionId: source._id, sourceQuestionUpdatedAt: source.updatedAt, sourceVersion,
        taskId: task._id, provider: task.provider, status: 'draft', version: 1,
        createdAt: new Date(), updatedAt: new Date()
      }));
      await db.runTransaction(async (transaction) => {
        const { data: currentTask } = await transaction.collection('tasks').doc(task._id).get();
        if (currentTask.status !== 'running' || currentTask.deadlineAt <= Date.now()) throw error('AI_TIMEOUT', '出题任务超时，请重新生成');
        const { data: current } = await transaction.collection('wrong_questions').doc(source._id).get();
        if (!current || current.ownerId !== user._id || current.deletedAt) throw error('NOT_FOUND', '错题不存在');
        domain.checkSource({ sourceVersion }, current);
        for (const item of results) {
          const { _id, ...fields } = item;
          await transaction.collection('generated_questions').doc(_id).set({ data: fields });
        }
        await transaction.collection('tasks').doc(task._id).update({ data: {
          status: 'completed', generatedQuestionIds: results.map((item) => item._id), updatedAt: Date.now()
        } });
      });
      return results;
    } catch (failure) {
      await db.runTransaction(async (transaction) => {
        const { data: current } = await transaction.collection('tasks').doc(task._id).get();
        if (current.status !== 'running') return;
        await transaction.collection('tasks').doc(task._id).update({ data: {
          status: 'failed', errorCode: failure.code || 'AI_PROVIDER_FAILED', error: publicMessage(failure), updatedAt: Date.now()
        } });
      });
      throw failure;
    }
  }

  return { create, getTask, status: () => adapter.status() };
}

module.exports = { createService };
