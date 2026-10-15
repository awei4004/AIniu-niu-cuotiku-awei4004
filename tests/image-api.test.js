const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./helpers/api-harness');
const rules = require('../miniprogram/services/image-domain');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY5kAAAAASUVORK5CYII=', 'base64');

async function upload(api, mode, requestId = 'upload_first') {
  const file = await api.call('file.register', { format: 'png', size: png.length, requestId });
  const data = mode === 'cloud' ? { cloudFileId: `cloud://test.bucket/${file.cloudPath}` }
    : { localPath: `wxfile://usr/${file._id}.png` };
  if (mode === 'cloud') api.putCloudFile(data.cloudFileId, png);
  return api.call('file.complete', Object.assign({ fileId: file._id }, data));
}

for (const mode of ['local', 'cloud']) {
  test(`${mode}: image recognition, manual correction, persistence and idempotent save`, async () => {
    const api = createBackend(mode);
    const student = await api.call('student.create', { name: '原图学生', grade: 3 });
    const file = await upload(api, mode);
    assert.equal((await upload(api, mode))._id, file._id);
    assert.equal(api.inspect('files').length, 1);
    assert.ok((await api.call('file.access', { fileId: file._id })).url);
    const data = { fileId: file._id, subject: 'math', requestId: 'ocr_first' };
    const task = await api.call('ocr.recognize', data);
    assert.equal(task.status, 'completed');
    assert.equal(task.result.provider, mode === 'local' ? 'demo' : 'tencent');
    assert.equal(task.result.text, '23 × 14 =');
    assert.equal((await api.call('ocr.recognize', data))._id, task._id);
    assert.equal((await api.call('task.get', { requestId: data.requestId }))._id, task._id);
    assert.equal(api.inspect('tasks').length, 1);
    if (mode === 'cloud') assert.equal(api.ocrCalls(), 1);
    const payload = { studentId: student._id, subject: 'math', questionText: '23 × 15 =',
      sourceFileId: file._id, ocrTaskId: task._id, ocrReviewed: true, requestId: 'question_first' };
    const question = await api.call('question.create', payload);
    assert.equal((await api.call('question.create', payload))._id, question._id);
    assert.equal(api.inspect('wrong_questions').length, 1);
    assert.equal(question.questionText, '23 × 15 =');
    assert.equal(question.sourceFileId, file._id);
    assert.equal(question.ocrTaskId, task._id);
    const updated = await api.call('question.update', { studentId: student._id, subject: 'math', questionText: question.questionText,
      questionId: question._id, mastery: 'reviewing', expectedVersion: question.version });
    assert.equal(updated.sourceFileId, file._id);
    const removed = await api.call('question.update', { studentId: student._id, subject: 'math', questionText: question.questionText,
      questionId: question._id, sourceFileId: '', ocrTaskId: '', expectedVersion: updated.version });
    assert.equal(removed.sourceFileId, '');
    assert.equal(removed.ocrReviewed, false);
    assert.ok((await api.call('file.access', { fileId: file._id })).url);
  });

  test(`${mode}: reject invalid upload, pending image and unreviewed or mismatched task`, async () => {
    const api = createBackend(mode);
    const student = await api.call('student.create', { name: '边界学生', grade: 1 });
    for (const data of [{ format: 'gif', size: 30 }, { format: 'png', size: rules.MAX_BYTES + 1 }, { format: 'png', size: 0 }]) {
      await assert.rejects(api.call('file.register', { ...data, requestId: 'upload_limits' }), { code: 'FILE_INVALID' });
    }
    await assert.rejects(api.call('file.register', { format: 'png', size: 10, requestId: '../oops' }), { code: 'VALIDATION_ERROR' });
    const pending = await api.call('file.register', { format: 'png', size: png.length, requestId: 'upload_pending' });
    await assert.rejects(api.call('ocr.recognize', { fileId: pending._id, requestId: 'ocr_pending', subject: 'math' }), { code: 'FILE_INVALID' });
    const payload = { studentId: student._id, subject: 'math', questionText: '1 + 2 =', sourceFileId: pending._id };
    await assert.rejects(api.call('question.create', payload), { code: 'FILE_INVALID' });
    const file = await upload(api, mode);
    const second = await upload(api, mode, 'upload_second');
    const task = await api.call('ocr.recognize', { fileId: file._id, requestId: 'ocr_check', subject: 'math' });
    await assert.rejects(api.call('question.create', { ...payload, sourceFileId: file._id, ocrTaskId: task._id }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(api.call('question.create', { ...payload, sourceFileId: second._id, ocrTaskId: task._id, ocrReviewed: true }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(api.call('question.create', { ...payload, sourceFileId: '', ocrTaskId: task._id, ocrReviewed: true }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(api.call('ocr.recognize', { fileId: file._id, requestId: 'ocr_check', subject: 'chinese' }), { code: 'CONFLICT' });
    const saved = await api.call('question.create', { ...payload, sourceFileId: file._id, requestId: 'save_conflict' });
    await assert.rejects(api.call('question.create', { ...payload, sourceFileId: file._id, questionText: '1 + 3 =', requestId: 'save_conflict' }), { code: 'CONFLICT' });
    await api.call('question.update', { ...payload, sourceFileId: file._id, questionId: saved._id, questionText: '1 + 3 =', expectedVersion: 1 });
    await assert.rejects(api.call('question.update', { ...payload, sourceFileId: file._id, questionId: saved._id, expectedVersion: 1 }), { code: 'CONFLICT' });
  });

  test(`${mode}: isolate image access, OCR tasks and question image references by owner`, async () => {
    const api = createBackend(mode);
    const file = await upload(api, mode);
    const task = await api.call('ocr.recognize', { fileId: file._id, requestId: 'ocr_alice', subject: 'math' });
    api.switchUser('bob');
    const student = await api.call('student.create', { name: '另一个用户', grade: 3 });
    for (const action of ['file.access', 'file.complete', 'ocr.recognize']) {
      await assert.rejects(api.call(action, { fileId: file._id, requestId: 'ocr_bob_test', subject: 'math' }), { code: 'NOT_FOUND' });
    }
    await assert.rejects(api.call('task.get', { taskId: task._id }), { code: 'NOT_FOUND' });
    await assert.rejects(api.call('question.create', { studentId: student._id, subject: 'math', questionText: '题目', sourceFileId: file._id }), { code: 'NOT_FOUND' });
    const own = await upload(api, mode, 'upload_bob');
    await assert.rejects(api.call('question.create', { studentId: student._id, subject: 'math', questionText: '题目',
      sourceFileId: own._id, ocrTaskId: task._id, ocrReviewed: true }), { code: 'NOT_FOUND' });
  });
}

test('cloud: verify bytes and upload path, detect modified cloud images', async () => {
  const api = createBackend('cloud');
  const file = await api.call('file.register', { format: 'png', size: png.length, requestId: 'upload_content' });
  await assert.rejects(api.call('file.complete', { fileId: file._id, cloudFileId: 'cloud://test.bucket/question-images/bob/other.png' }), { code: 'FILE_INVALID' });
  const cloudFileId = `cloud://test.bucket/${file.cloudPath}`;
  api.putCloudFile(cloudFileId, Buffer.alloc(png.length));
  await assert.rejects(api.call('file.complete', { fileId: file._id, cloudFileId }), { code: 'FILE_INVALID' });
  api.putCloudFile(cloudFileId, png);
  await api.call('file.complete', { fileId: file._id, cloudFileId });
  const altered = Buffer.from(png);
  altered[altered.length - 1] ^= 1;
  api.putCloudFile(cloudFileId, altered);
  await assert.rejects(api.call('file.access', { fileId: file._id }), { code: 'FILE_INVALID' });
  const task = await api.call('ocr.recognize', { fileId: file._id, subject: 'math', requestId: 'ocr_altered' });
  assert.equal(task.status, 'failed');
  assert.equal(api.ocrCalls(), 0);
});

test('cloud: failed OCR retains image, supports manual save and explicit new retry', async () => {
  const api = createBackend('cloud');
  const student = await api.call('student.create', { name: '失败学生', grade: 2 });
  const file = await upload(api, 'cloud');
  api.setOcrAdapter(async () => { throw rules.error('OCR_NOT_CONFIGURED', 'OCR 未配置'); });
  const data = { fileId: file._id, subject: 'math', requestId: 'ocr_failure' };
  const failed = await api.call('ocr.recognize', data);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'OCR_NOT_CONFIGURED');
  await api.call('ocr.recognize', data);
  assert.equal(api.ocrCalls(), 1);
  const question = await api.call('question.create', { studentId: student._id, subject: 'math', questionText: '手工题目', sourceFileId: file._id });
  assert.equal(question.sourceFileId, file._id);
  api.setOcrAdapter(async () => ({ provider: 'tencent', text: '重新识别的题目' }));
  const retry = await api.call('ocr.recognize', { ...data, requestId: 'ocr_retry' });
  assert.equal(retry.status, 'completed');
  assert.notEqual(retry._id, failed._id);
  assert.equal(api.ocrCalls(), 2);
});

test('cloud: concurrent retries share one provider call and timed out tasks reject late results', async () => {
  const api = createBackend('cloud');
  const file = await upload(api, 'cloud');
  let release;
  let started;
  const waitStart = new Promise((resolve) => { started = resolve; });
  api.setOcrAdapter(() => { started(); return new Promise((resolve) => { release = resolve; }); });
  const data = { fileId: file._id, subject: 'math', requestId: 'ocr_concurrent' };
  const first = api.call('ocr.recognize', data);
  await waitStart;
  const retry = await api.call('ocr.recognize', data);
  assert.equal(retry.status, 'running');
  assert.equal(api.ocrCalls(), 1);
  api.advanceClock(rules.TASK_TIMEOUT + 1);
  const expired = await api.call('task.get', { requestId: data.requestId });
  assert.equal(expired.status, 'failed');
  assert.equal(expired.errorCode, 'PROVIDER_TIMEOUT');
  release({ provider: 'tencent', text: '迟到结果' });
  assert.equal((await first).status, 'failed');
  assert.equal((await api.call('task.get', { taskId: expired._id })).result, undefined);
});

test('OCR output rejects empty text, excessive length and malformed response', () => {
  assert.throws(() => rules.ocrResult({ text: ' ' }), { code: 'OCR_EMPTY' });
  assert.throws(() => rules.ocrResult({ text: '题'.repeat(5001) }), { code: 'OCR_TOO_LONG' });
  assert.throws(() => rules.ocrResult({ text: null }), { code: 'OCR_EMPTY' });
});

module.exports = { png };
