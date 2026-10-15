const storage = require('../utils/storage');
const rules = require('./image-domain');
const actions = ['file.register', 'file.complete', 'file.access', 'ocr.recognize', 'task.get'];

function ownedFile(user, id, ready = true) {
  const file = storage.getFiles().find((item) => item._id === id && item.ownerId === user._id);
  if (!file) throw rules.error('NOT_FOUND', '原图不存在');
  if (ready && file.status !== 'ready') throw rules.error('FILE_INVALID', '原图尚未上传完成');
  return file;
}

function ownedTask(user, data) {
  const task = storage.getTasks().find((item) => item.ownerId === user._id
    && (data.taskId ? item._id === data.taskId : item.type === 'ocr' && item.requestId === data.requestId));
  if (!task) throw rules.error('NOT_FOUND', '任务不存在');
  return task;
}

function questionImage(user, data, current = {}) {
  const sourceFileId = data.sourceFileId === undefined ? current.sourceFileId || '' : data.sourceFileId;
  const ocrTaskId = data.ocrTaskId === undefined ? current.ocrTaskId || '' : data.ocrTaskId;
  if (typeof sourceFileId !== 'string' || typeof ocrTaskId !== 'string') throw rules.error('VALIDATION_ERROR', '原图引用格式不正确');
  const file = sourceFileId ? ownedFile(user, sourceFileId) : null;
  if (ocrTaskId) rules.checkBinding(ownedTask(user, { taskId: ocrTaskId }), file,
    data.ocrReviewed === undefined ? current.ocrReviewed : data.ocrReviewed);
  return { sourceFileId, ocrTaskId, ocrReviewed: Boolean(ocrTaskId) };
}

function call(action, data, user) {
  if (action === 'file.register') {
    const requestId = rules.requestId(data.requestId);
    const fields = rules.uploadFields(data);
    const files = storage.getFiles();
    const existing = files.find((item) => item.ownerId === user._id && item.requestId === requestId);
    if (existing) {
      if (existing.size !== fields.size || existing.format !== fields.format) throw rules.error('CONFLICT', '上传编号已用于另一张图片');
      return existing;
    }
    const file = Object.assign({ _id: storage.makeId('file'), ownerId: user._id,
      requestId, status: 'pending', createdAt: Date.now() }, fields);
    storage.saveFiles([file].concat(files));
    return file;
  }
  if (action === 'file.complete') {
    const file = ownedFile(user, data.fileId, false);
    if (typeof data.localPath !== 'string' || !/^wxfile:\/\/(?:usr|store)\//.test(data.localPath)
      && !/^https?:\/\/usr\//.test(data.localPath)) {
      throw rules.error('FILE_INVALID', '请先将原图保存到本地持久目录');
    }
    if (file.status === 'ready') {
      if (file.localPath !== data.localPath) throw rules.error('CONFLICT', '原图已完成上传');
      return file;
    }
    const updated = Object.assign({}, file, { localPath: data.localPath, status: 'ready', updatedAt: Date.now() });
    storage.saveFiles(storage.getFiles().map((item) => item._id === file._id ? updated : item));
    return updated;
  }
  if (action === 'file.access') {
    const file = ownedFile(user, data.fileId);
    return { fileId: file._id, url: file.localPath, provider: 'local' };
  }
  if (action === 'task.get') return ownedTask(user, data);
  if (action === 'ocr.recognize') {
    const requestId = rules.requestId(data.requestId);
    const file = ownedFile(user, data.fileId);
    const subject = rules.subject(data.subject);
    const existing = storage.getTasks().find((item) => item.ownerId === user._id && item.type === 'ocr' && item.requestId === requestId);
    if (existing) {
      if (existing.fileId !== file._id || existing.subject !== subject) throw rules.error('CONFLICT', '识别编号已用于另一张图片或学科');
      return existing;
    }
    const task = { _id: storage.makeId('ocr'), ownerId: user._id, type: 'ocr', fileId: file._id,
      requestId, subject, provider: 'demo', status: 'completed', result: rules.demoRecognize(subject),
      createdAt: Date.now(), updatedAt: Date.now() };
    storage.saveTasks([task].concat(storage.getTasks()));
    return task;
  }
}

module.exports = { actions, call, questionImage };
