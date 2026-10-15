const crypto = require('crypto');
const rules = require('./image-domain');
const actions = ['file.register', 'file.complete', 'file.access', 'ocr.recognize', 'task.get'];
const idFor = (owner, type, request) => crypto.createHash('sha256').update(JSON.stringify([owner, type, request])).digest('hex');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function createService({ cloud, db, adapter }) {
  async function ownedFile(user, id, ready = true) {
    if (typeof id !== 'string' || !id) throw rules.error('NOT_FOUND', '原图不存在');
    const { data: file } = await db.collection('files').doc(id).get();
    if (!file || file.ownerId !== user._id) throw rules.error('NOT_FOUND', '原图不存在');
    if (ready && file.status !== 'ready') throw rules.error('FILE_INVALID', '原图尚未上传完成');
    return file;
  }

  async function ownedTask(user, data) {
    const id = data.taskId || idFor(user._id, 'ocr', rules.requestId(data.requestId));
    const { data: task } = await db.collection('tasks').doc(id).get();
    if (!task || task.ownerId !== user._id) throw rules.error('NOT_FOUND', '任务不存在');
    if (task.type === 'ocr' && task.status === 'running' && task.deadlineAt <= Date.now()) {
      return db.runTransaction(async (transaction) => {
        const { data: current } = await transaction.collection('tasks').doc(id).get();
        if (current.status !== 'running') return current;
        const fields = { status: 'failed', errorCode: 'PROVIDER_TIMEOUT',
          error: '识别任务已超时，可手动录入或重新识别', updatedAt: Date.now() };
        await transaction.collection('tasks').doc(id).update({ data: fields });
        return Object.assign({}, current, fields);
      });
    }
    return task;
  }

  async function questionImage(user, data, current = {}) {
    const sourceFileId = data.sourceFileId === undefined ? current.sourceFileId || '' : data.sourceFileId;
    const ocrTaskId = data.ocrTaskId === undefined ? current.ocrTaskId || '' : data.ocrTaskId;
    if (typeof sourceFileId !== 'string' || typeof ocrTaskId !== 'string') throw rules.error('VALIDATION_ERROR', '原图引用格式不正确');
    const file = sourceFileId ? await ownedFile(user, sourceFileId) : null;
    if (ocrTaskId) rules.checkBinding(await ownedTask(user, { taskId: ocrTaskId }), file,
      data.ocrReviewed === undefined ? current.ocrReviewed : data.ocrReviewed);
    return { sourceFileId, ocrTaskId, ocrReviewed: Boolean(ocrTaskId) };
  }

  async function fileBytes(file) {
    let response;
    try { response = await cloud.downloadFile({ fileID: file.cloudFileId }); }
    catch (error) { throw rules.error('FILE_INVALID', '无法读取原图，请重新上传'); }
    const bytes = response.fileContent;
    rules.checkImage(bytes, file);
    if (file.contentHash && file.contentHash !== digest(bytes)) throw rules.error('FILE_INVALID', '原图内容已改变，请重新上传');
    return bytes;
  }

  async function register(user, data) {
    const requestId = rules.requestId(data.requestId);
    const fields = rules.uploadFields(data);
    const id = idFor(user._id, 'file', requestId);
    return db.runTransaction(async (transaction) => {
      const { data: existing } = await transaction.collection('files').doc(id).get();
      if (existing) {
        if (existing.size !== fields.size || existing.format !== fields.format) throw rules.error('CONFLICT', '上传编号已用于另一张图片');
        return existing;
      }
      const file = Object.assign({ _id: id, ownerId: user._id, requestId, status: 'pending',
        cloudPath: `question-images/${user.openid}/${id}.${fields.format}`, createdAt: Date.now() }, fields);
      const { _id, ...document } = file;
      await transaction.collection('files').doc(_id).set({ data: document });
      return file;
    });
  }

  async function complete(user, data) {
    const file = await ownedFile(user, data.fileId, false);
    const match = typeof data.cloudFileId === 'string' && data.cloudFileId.match(/^cloud:\/\/[^/]+\/(.+)$/);
    if (!match || match[1] !== file.cloudPath) throw rules.error('FILE_INVALID', '上传路径与当前用户的文件登记不匹配');
    if (file.status === 'ready') {
      if (file.cloudFileId !== data.cloudFileId) throw rules.error('CONFLICT', '原图已完成上传');
      return file;
    }
    const bytes = await fileBytes(Object.assign({}, file, { cloudFileId: data.cloudFileId }));
    const fields = { cloudFileId: data.cloudFileId, contentHash: digest(bytes), status: 'ready', updatedAt: Date.now() };
    return db.runTransaction(async (transaction) => {
      const { data: current } = await transaction.collection('files').doc(file._id).get();
      if (current.status === 'ready') {
        if (current.cloudFileId !== data.cloudFileId) throw rules.error('CONFLICT', '原图已完成上传');
        return current;
      }
      await transaction.collection('files').doc(file._id).update({ data: fields });
      return Object.assign({}, current, fields);
    });
  }

  async function access(user, data) {
    const file = await ownedFile(user, data.fileId);
    await fileBytes(file);
    const response = await cloud.getTempFileURL({ fileList: [file.cloudFileId] });
    const item = response.fileList && response.fileList[0];
    if (!item || item.status !== 0 || !item.tempFileURL) throw rules.error('FILE_INVALID', '原图暂时无法访问，请稍后重试');
    return { fileId: file._id, url: item.tempFileURL, provider: 'cloud' };
  }

  async function recognize(user, data) {
    const requestId = rules.requestId(data.requestId);
    const file = await ownedFile(user, data.fileId);
    const subject = rules.subject(data.subject);
    const id = idFor(user._id, 'ocr', requestId);
    const claim = await db.runTransaction(async (transaction) => {
      const { data: existing } = await transaction.collection('tasks').doc(id).get();
      if (existing) {
        if (existing.fileId !== file._id || existing.subject !== subject) throw rules.error('CONFLICT', '识别编号已用于另一张图片或学科');
        return { acquired: false, task: existing };
      }
      const task = { _id: id, ownerId: user._id, type: 'ocr', requestId, fileId: file._id, subject,
        provider: adapter.provider(), status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
        deadlineAt: Date.now() + rules.TASK_TIMEOUT };
      const { _id, ...document } = task;
      await transaction.collection('tasks').doc(_id).set({ data: document });
      return { acquired: true, task };
    });
    if (!claim.acquired) return ownedTask(user, { taskId: id });
    let fields;
    try {
      const result = rules.ocrResult(await adapter.recognize(await fileBytes(file)));
      fields = { status: 'completed', result, provider: result.provider, updatedAt: Date.now() };
    } catch (error) {
      fields = { status: 'failed', errorCode: error.code || 'PROVIDER_FAILED', error: rules.failureMessage(error), updatedAt: Date.now() };
    }
    return db.runTransaction(async (transaction) => {
      const { data: current } = await transaction.collection('tasks').doc(id).get();
      if (current.status !== 'running') return current;
      if (current.deadlineAt <= Date.now()) fields = { status: 'failed', errorCode: 'PROVIDER_TIMEOUT',
        error: '识别任务已超时，可手动录入或重新识别', updatedAt: Date.now() };
      await transaction.collection('tasks').doc(id).update({ data: fields });
      return Object.assign({}, current, fields);
    });
  }

  return { actions, questionImage, async call(action, data, user) {
    if (action === 'file.register') return register(user, data);
    if (action === 'file.complete') return complete(user, data);
    if (action === 'file.access') return access(user, data);
    if (action === 'ocr.recognize') return recognize(user, data);
    if (action === 'task.get') return ownedTask(user, data);
  } };
}

module.exports = { createService };
