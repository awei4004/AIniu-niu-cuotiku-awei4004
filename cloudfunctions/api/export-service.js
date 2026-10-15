const crypto = require('crypto');
const rules = require('./export-domain');
const imageRules = require('./image-domain');
const actions = ['export.create', 'export.retry', 'export.list', 'export.access'];
const idFor = (owner, request) => crypto.createHash('sha256').update(JSON.stringify([owner, 'export', request])).digest('hex');

function createService({ cloud, db, renderer }) {
  async function owned(user, data) {
    const id = data.taskId || idFor(user._id, rules.requestId(data.requestId));
    const { data: task } = await db.collection('tasks').doc(id).get();
    if (!task || task.ownerId !== user._id || task.type !== 'export') throw rules.error('NOT_FOUND', '导出任务不存在');
    if (task.status !== 'running' || task.deadlineAt > Date.now()) return task;
    return db.runTransaction(async (tx) => {
      const { data: current } = await tx.collection('tasks').doc(id).get();
      if (current.status !== 'running' || current.deadlineAt > Date.now()) return current;
      const fields = { status: 'failed', error: '导出任务已超时，请重试', updatedAt: Date.now() };
      await tx.collection('tasks').doc(id).update({ data: fields });
      return Object.assign({}, current, fields);
    });
  }

  async function source(user, fields) {
    const { data: student } = await db.collection('students').doc(fields.studentId).get();
    if (!student || student.ownerId !== user._id) throw rules.error('NOT_FOUND', '学生不存在');
    const questions = await Promise.all(fields.questionIds.map(async (id) => {
      const { data: q } = await db.collection('wrong_questions').doc(id).get();
      return q && q.ownerId === user._id ? q : null;
    }));
    return rules.snapshot(fields, student, questions);
  }

  async function loadImage(user, id) {
    const { data: file } = await db.collection('files').doc(id).get();
    if (!file || file.ownerId !== user._id || file.status !== 'ready') throw rules.error('FILE_INVALID', '原图不存在或无法读取，请关闭附带原图后重试');
    const response = await cloud.downloadFile({ fileID: file.cloudFileId });
    const bytes = response.fileContent;
    imageRules.checkImage(bytes, file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.contentHash) throw rules.error('FILE_INVALID', '原图内容已改变，请重新上传');
    return { bytes, format: file.format };
  }

  async function generate(user, task) {
    let fields;
    let uploaded;
    try {
      const document = await renderer.render(task.snapshot, { loadImage: (id) => loadImage(user, id) });
      const current = await owned(user, { taskId: task._id });
      if (current.status !== 'running' || current.attempt !== task.attempt) return current;
      // Attempt-specific paths prevent a slow upload from overwriting a successful retry.
      uploaded = await cloud.uploadFile({ cloudPath: `exports/${user.openid}/${task._id}_${task.attempt}.pdf`, fileContent: Buffer.from(document.bytes) });
      fields = { status: 'completed', result: { cloudFileId: uploaded.fileID, pageCount: document.pageCount, size: document.bytes.length } };
    } catch (error) { fields = { status: 'failed', error: rules.failure(error) }; }
    const result = await db.runTransaction(async (tx) => {
      const { data: current } = await tx.collection('tasks').doc(task._id).get();
      if (current.status !== 'running' || current.attempt !== task.attempt) return current;
      if (current.deadlineAt <= Date.now()) fields = { status: 'failed', error: '导出任务已超时，请重试' };
      fields.updatedAt = Date.now();
      await tx.collection('tasks').doc(task._id).update({ data: fields });
      return Object.assign({}, current, fields);
    });
    if (uploaded && (!result.result || result.result.cloudFileId !== uploaded.fileID)) {
      await cloud.deleteFile({ fileList: [uploaded.fileID] }).catch(() => {});
    }
    return result;
  }

  async function create(user, data) {
    const requestId = rules.requestId(data.requestId);
    const fields = rules.options(data);
    const id = idFor(user._id, requestId);
    const { data: previous } = await db.collection('tasks').doc(id).get();
    if (previous) { rules.checkRequest(previous, fields); return owned(user, { taskId: id }); }
    const snapshot = await source(user, fields);
    const claim = await db.runTransaction(async (tx) => {
      const { data: existing } = await tx.collection('tasks').doc(id).get();
      if (existing) return { acquired: false, task: rules.checkRequest(existing, fields) };
      const task = { _id: id, type: 'export', ownerId: user._id, requestId, fingerprint: JSON.stringify(fields),
        snapshot, status: 'running', provider: 'cloud', attempt: 1, deadlineAt: Date.now() + rules.TIMEOUT,
        createdAt: Date.now(), updatedAt: Date.now() };
      const { _id, ...document } = task;
      await tx.collection('tasks').doc(_id).set({ data: document });
      return { acquired: true, task };
    });
    return claim.acquired ? generate(user, claim.task) : claim.task;
  }

  async function retry(user, data) {
    const task = await owned(user, data);
    const claim = await db.runTransaction(async (tx) => {
      const { data: current } = await tx.collection('tasks').doc(task._id).get();
      if (current.status !== 'failed') return { acquired: false, task: current };
      const fields = { status: 'running', error: '', attempt: current.attempt + 1,
        deadlineAt: Date.now() + rules.TIMEOUT, updatedAt: Date.now() };
      await tx.collection('tasks').doc(task._id).update({ data: fields });
      return { acquired: true, task: Object.assign({}, current, fields) };
    });
    return claim.acquired ? generate(user, claim.task) : claim.task;
  }

  return { actions, async call(action, data, user) {
    if (action === 'export.create') return create(user, data);
    if (action === 'export.retry') return retry(user, data);
    if (action === 'export.list') {
      const { data: tasks } = await db.collection('tasks').where({ ownerId: user._id, type: 'export' }).orderBy('createdAt', 'desc').limit(20).get();
      return Promise.all(tasks.map(async (task) => rules.summary(await owned(user, { taskId: task._id }))));
    }
    const task = await owned(user, data);
    if (action === 'task.get') return task;
    if (task.status !== 'completed') throw rules.error('INVALID_STATUS', 'PDF 尚未生成完成');
    const response = await cloud.getTempFileURL({ fileList: [task.result.cloudFileId] });
    const item = response.fileList && response.fileList[0];
    if (!item || item.status !== 0 || !item.tempFileURL) throw rules.error('FILE_INVALID', 'PDF 暂时无法访问，请重试');
    return { provider: 'cloud', url: item.tempFileURL, cloudFileId: task.result.cloudFileId, pageCount: task.result.pageCount };
  } };
}

module.exports = { createService };
