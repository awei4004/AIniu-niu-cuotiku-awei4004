const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./helpers/api-harness');
const rules = require('../miniprogram/services/export-domain');

async function fixture(mode) {
  const api = createBackend(mode);
  const student = await api.call('student.create', { name: '小明', grade: 3 });
  const questions = [];
  for (let i = 0; i < 3; i += 1) questions.push(await api.call('question.create', { studentId: student._id,
    subject: i === 2 ? 'chinese' : 'math', questionText: `复习题 ${i + 1}：23 × 14 =`, correctAnswer: '答案秘密322',
    studentAnswer: '原答秘密332', errorReason: '原因秘密', analysis: '解析秘密', knowledgePoints: '知识点秘密' }));
  const fields = { studentId: student._id, questionIds: questions.map((q) => q._id), template: 'practice', requestId: 'export_first_request', includeImages: true };
  return { api, student, questions, fields };
}

for (const mode of ['local', 'cloud']) {
  test(`${mode}: export snapshots remove answers and preserve idempotency after source changes`, async () => {
    const { api, fields, questions, student } = await fixture(mode);
    const task = await api.call('export.create', fields);
    assert.equal(task.snapshot.questions.length, 3);
    assert.equal(task.snapshot.includeImages, false);
    assert.equal(JSON.stringify(task.snapshot).includes('秘密'), false);
    for (const q of task.snapshot.questions) {
      for (const field of ['correctAnswer', 'studentAnswer', 'errorReason', 'analysis', 'knowledgePoints', 'sourceFileId']) assert.equal(q[field], undefined);
    }
    await api.call('question.update', { ...questions[0], studentId: student._id, questionId: questions[0]._id,
      questionText: '修改后的题目', expectedVersion: questions[0].version });
    await api.call('question.delete', { questionId: questions[1]._id });
    assert.deepEqual(await api.call('export.create', fields), task);
    assert.equal((await api.call('task.get', { type: 'export', requestId: fields.requestId }))._id, task._id);
    await assert.rejects(api.call('export.create', { ...fields, template: 'analysis' }), { code: 'CONFLICT' });
    assert.equal((await api.call('export.list')).length, 1);
    if (mode === 'cloud') { assert.equal(api.pdfCalls(), 1); assert.equal(api.uploads().length, 1); }
  });

  test(`${mode}: export rejects cross-student, foreign, deleted and excessive selections`, async () => {
    const { api, fields, questions } = await fixture(mode);
    const second = await api.call('student.create', { name: '小红', grade: 2 });
    const q = await api.call('question.create', { studentId: second._id, subject: 'math', questionText: '1 + 1 =' });
    for (const data of [
      { questionIds: [] }, { questionIds: Array(21).fill(q._id) }, { questionIds: [q._id, q._id] },
      { template: 'unknown' }, { answerLines: 100 }, { title: 'x'.repeat(41) }, { includeImages: 'yes' }
    ]) await assert.rejects(api.call('export.create', { ...fields, ...data }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(api.call('export.create', { ...fields, questionIds: [q._id] }), { code: 'NOT_FOUND' });
    await api.call('question.delete', { questionId: questions[0]._id });
    await assert.rejects(api.call('export.create', fields), { code: 'NOT_FOUND' });
    api.switchUser('bob');
    await assert.rejects(api.call('export.create', fields), { code: 'NOT_FOUND' });
  });

  test(`${mode}: analysis exports retain explanations and isolate all export access`, async () => {
    const { api, fields } = await fixture(mode);
    let task = await api.call('export.create', { ...fields, template: 'analysis', includeImages: false });
    assert.equal(task.snapshot.questions[0].analysis, '解析秘密');
    assert.equal(task.snapshot.questions[0].correctAnswer, '答案秘密322');
    if (mode === 'local') {
      await assert.rejects(api.call('export.access', { taskId: task._id }), { code: 'INVALID_STATUS' });
      const result = { taskId: task._id, attempt: task.attempt, localPath: `wxfile://usr/export_${task._id}.pdf`, pageCount: 2 };
      await assert.rejects(api.call('export.complete', { ...result, localPath: 'http://tmp/fake.pdf' }), { code: 'FILE_INVALID' });
      task = await api.call('export.complete', result);
      assert.equal((await api.call('export.complete', result))._id, task._id);
    }
    assert.equal(task.status, 'completed');
    assert.ok((await api.call('export.access', { taskId: task._id })).url);
    assert.equal((await api.call('export.retry', { taskId: task._id }))._id, task._id);
    api.switchUser('bob');
    for (const action of ['export.access', 'export.retry', 'task.get']) await assert.rejects(api.call(action, { type: 'export', taskId: task._id }), { code: 'NOT_FOUND' });
    assert.equal((await api.call('export.list')).length, 0);
  });
}

test('local: failed export retries preserve snapshots and reject stale completion attempts', async () => {
  const { api, fields } = await fixture('local');
  const task = await api.call('export.create', fields);
  await api.call('export.fail', { taskId: task._id, attempt: 1 });
  const retry = await api.call('export.retry', { taskId: task._id });
  assert.equal(retry._id, task._id);
  assert.equal(retry.attempt, 2);
  assert.deepEqual(retry.snapshot, task.snapshot);
  await assert.rejects(api.call('export.complete', { taskId: task._id, attempt: 1 }), { code: 'CONFLICT' });
  api.advanceClock(rules.TIMEOUT + 1);
  assert.equal((await api.call('task.get', { type: 'export', taskId: task._id })).status, 'failed');
});

test('cloud: concurrent creates share a task and late attempts cannot replace a successful retry', async () => {
  const { api, fields } = await fixture('cloud');
  let release;
  api.setPdfRenderer(() => new Promise((resolve) => { release = resolve; }));
  const first = api.call('export.create', fields);
  await new Promise((resolve) => setImmediate(resolve));
  const pending = await api.call('export.create', fields);
  assert.equal(pending.status, 'running');
  assert.equal(api.pdfCalls(), 1);
  api.advanceClock(rules.TIMEOUT + 1);
  assert.equal((await api.call('task.get', { type: 'export', taskId: pending._id })).status, 'failed');
  api.setPdfRenderer(async () => { throw new Error('internal secret should not appear'); });
  assert.equal((await api.call('export.retry', { taskId: pending._id })).status, 'failed');
  api.setPdfRenderer(async () => ({ bytes: Buffer.from('%PDF-retry'), pageCount: 2 }));
  const finished = await api.call('export.retry', { taskId: pending._id });
  release({ bytes: Buffer.from('%PDF-late'), pageCount: 1 });
  assert.equal((await first).result.pageCount, 2);
  assert.equal(finished.result.pageCount, 2);
  assert.equal(new Set(api.uploads()).size, 1);
  assert.equal(api.getCloudFile(finished.result.cloudFileId).toString(), '%PDF-retry');
  assert.equal(api.inspect('tasks').filter((t) => t.type === 'export').length, 1);
});
