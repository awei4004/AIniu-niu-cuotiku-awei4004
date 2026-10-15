const storage = require('../utils/storage');
const rules = require('./export-domain');
const actions = ['export.create', 'export.retry', 'export.complete', 'export.fail', 'export.list', 'export.access'];

function save(task) {
  storage.saveTasks([task].concat(storage.getTasks().filter((item) => item._id !== task._id)));
  return task;
}

function owned(user, data) {
  const task = storage.getTasks().find((item) => item.ownerId === user._id && item.type === 'export'
    && (data.taskId ? item._id === data.taskId : item.requestId === data.requestId));
  if (!task) throw rules.error('NOT_FOUND', '导出任务不存在');
  if (task.status === 'running' && task.deadlineAt <= Date.now()) return save(Object.assign({}, task,
    { status: 'failed', error: '导出任务已超时，请重试', updatedAt: Date.now() }));
  return task;
}

function call(action, data, user) {
  if (action === 'export.create') {
    const requestId = rules.requestId(data.requestId);
    const fields = rules.options(data);
    const previous = storage.getTasks().find((t) => t.ownerId === user._id && t.type === 'export' && t.requestId === requestId);
    if (previous) { rules.checkRequest(previous, fields); return owned(user, { taskId: previous._id }); }
    const student = storage.getStudents().find((s) => s.ownerId === user._id && s._id === fields.studentId);
    const questions = fields.questionIds.map((id) => storage.getQuestions().find((q) => q._id === id && q.ownerId === user._id && !q.deletedAt));
    const snapshot = rules.snapshot(fields, student, questions);
    return save({ _id: storage.makeId('export'), type: 'export', ownerId: user._id, requestId,
      fingerprint: JSON.stringify(fields), snapshot, status: 'running', provider: 'local', attempt: 1,
      deadlineAt: Date.now() + rules.TIMEOUT, createdAt: Date.now(), updatedAt: Date.now() });
  }
  if (action === 'export.list') return storage.getTasks().filter((t) => t.ownerId === user._id && t.type === 'export')
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((t) => rules.summary(owned(user, { taskId: t._id })));
  const task = owned(user, data);
  if (action === 'task.get') return task;
  if (action === 'export.retry') {
    if (task.status !== 'failed') return task;
    return save(Object.assign({}, task, { status: 'running', error: '', attempt: task.attempt + 1,
      deadlineAt: Date.now() + rules.TIMEOUT, updatedAt: Date.now() }));
  }
  if (action === 'export.access') {
    if (task.status !== 'completed') throw rules.error('INVALID_STATUS', 'PDF 尚未生成完成');
    return { provider: 'local', url: task.result.localPath, pageCount: task.result.pageCount };
  }
  if (data.attempt !== task.attempt) throw rules.error('CONFLICT', '导出任务已重试，请查询最新状态');
  if (action === 'export.complete') {
    const expected = `export_${task._id}.pdf`;
    if (typeof data.localPath !== 'string' || !/^(wxfile:\/\/(usr|store)|https?:\/\/usr)\//.test(data.localPath)
      || data.localPath.split('/').pop() !== expected || !Number.isInteger(data.pageCount)
      || data.pageCount < 1 || data.pageCount > rules.MAX_PAGES) throw rules.error('FILE_INVALID', 'PDF 文件路径或页数不正确');
    if (task.status === 'completed') {
      if (task.result.localPath !== data.localPath) throw rules.error('CONFLICT', '导出已完成');
      return task;
    }
    if (task.status !== 'running') throw rules.error('INVALID_STATUS', '请重试后再完成导出');
    return save(Object.assign({}, task, { status: 'completed', updatedAt: Date.now(),
      result: { localPath: data.localPath, pageCount: data.pageCount } }));
  }
  if (action === 'export.fail' && task.status === 'running') return save(Object.assign({}, task,
    { status: 'failed', error: rules.failure(data), updatedAt: Date.now() }));
  return task;
}

module.exports = { actions, call };
