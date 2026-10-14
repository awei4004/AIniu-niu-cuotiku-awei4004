const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./helpers/api-harness');
const domain = require('../miniprogram/services/practice-domain');

const code = (value) => (error) => error.code === value;
async function fixture(mode, override = {}) {
  const api = createBackend(mode);
  const student = await api.call('student.create', { name: '练习学生', grade: 3 });
  const source = await api.call('question.create', Object.assign({ studentId: student._id,
    subject: 'math', questionType: '计算题', questionText: '23 × 14 =',
    correctAnswer: '322', knowledgePoints: '两位数乘法', analysis: '注意进位' }, override));
  return { api, source, student };
}

for (const mode of ['local', 'cloud']) {
  test(`${mode}: generate, edit, confirm, practice and preserve history`, async () => {
    const { api, source, student } = await fixture(mode);
    const questions = await api.call('generation.create', { sourceQuestionId: source._id, count: 3, difficulty: 2 });
    assert.equal(questions.length, 3);
    assert.equal(new Set(questions.map((item) => item.questionText)).size, 3);
    assert.ok(questions.every((item) => item.status === 'draft' && item.correctAnswer && item.analysis && item.provider === 'demo'));
    assert.deepEqual(await api.call('question.detail', { questionId: source._id }), source);
    assert.deepEqual(await api.call('practice.list'), []);
    const first = questions[0];
    const payload = { generatedQuestionId: first._id };
    await assert.rejects(api.call('practice.start', payload), code('INVALID_STATUS'));
    await assert.rejects(api.call('practice.submit', { ...payload, answer: '1', submissionId: 'draft' }), code('INVALID_STATUS'));
    const edited = await api.call('generation.update', { ...payload, questionText: '30 + 2 =', correctAnswer: '32', analysis: '30 加 2 得 32' });
    assert.equal(edited.status, 'draft');
    await api.call('generation.confirm', payload);
    const start = await api.call('practice.start', payload);
    assert.equal(start.correctAnswer, undefined);
    assert.equal(start.analysis, undefined);
    const available = await api.call('practice.list', { studentId: student._id });
    assert.equal(available.length, 1);
    assert.equal(available[0].correctAnswer, undefined);
    const submission = { ...payload, answer: '32', questionVersion: start.version, submissionId: 'first' };
    const record = await api.call('practice.submit', submission);
    assert.equal(record.resultStatus, 'correct');
    assert.equal(record.questionSnapshot.correctAnswer, '32');
    assert.equal((await api.call('practice.submit', submission))._id, record._id);
    assert.equal((await api.call('practice.records')).length, 1);
    const wrong = await api.call('practice.submit', { ...submission, answer: '3.2', submissionId: 'second' });
    assert.equal(wrong.resultStatus, 'wrong');
    await assert.rejects(api.call('practice.grade', { recordId: record._id, resultStatus: 'wrong' }), code('INVALID_STATUS'));
    await api.call('generation.update', { ...payload, questionText: '40 + 2 =', correctAnswer: '42', analysis: '40 加 2 得 42' });
    assert.deepEqual(await api.call('practice.list'), []);
    await api.call('generation.confirm', payload);
    await assert.rejects(api.call('practice.submit', { ...submission, submissionId: 'stale' }), code('QUESTION_CHANGED'));
    const old = await api.call('practice.detail', { recordId: record._id });
    assert.equal(old.questionSnapshot.questionText, '30 + 2 =');
    assert.equal(old.questionSnapshot.correctAnswer, '32');
    await api.call('generation.delete', payload);
    await assert.rejects(api.call('practice.start', payload), code('NOT_FOUND'));
    assert.equal((await api.call('practice.submit', submission))._id, record._id);
    assert.equal(api.inspect('tasks')[0].status, 'completed');
  });

  test(`${mode}: enforce limits, source versions and task failure`, async () => {
    const { api, source } = await fixture(mode);
    for (const count of [0, 4, -1, 1.5, 'abc']) {
      await assert.rejects(api.call('generation.create', { sourceQuestionId: source._id, count }), code('VALIDATION_ERROR'));
    }
    for (const difficulty of [0, 4, 'unknown', '']) {
      await assert.rejects(api.call('generation.create', { sourceQuestionId: source._id, difficulty }), code('VALIDATION_ERROR'));
    }
    const [question] = await api.call('generation.create', { sourceQuestionId: source._id, count: 1, difficulty: 1 });
    await assert.rejects(api.call('generation.update', { generatedQuestionId: question._id, analysis: '' }), code('VALIDATION_ERROR'));
    await api.call('question.update', { ...source, questionId: source._id, questionText: '12 × 15 =' });
    await assert.rejects(api.call('generation.confirm', { generatedQuestionId: question._id }), code('SOURCE_CHANGED'));
    const unsupported = await api.call('question.create', { studentId: source.studentId,
      subject: 'math', questionText: '1.2 + 3.4 =' });
    await assert.rejects(api.call('generation.create', { sourceQuestionId: unsupported._id }), code('UNSUPPORTED_GENERATION'));
    assert.ok(api.inspect('tasks').some((item) => item.status === 'failed'));
    assert.equal(api.inspect('generated_questions').length, 1);
  });

  test(`${mode}: open questions keep ungraded and allow adult grading from snapshots`, async () => {
    const { api, source, student } = await fixture(mode, { subject: 'chinese', questionText: '请写出美丽的近义词', knowledgePoints: '近义词' });
    const [question] = await api.call('generation.create', { sourceQuestionId: source._id });
    assert.equal(question.answerType, 'open');
    await api.call('generation.confirm', { generatedQuestionId: question._id });
    await assert.rejects(api.call('practice.submit', { generatedQuestionId: question._id, submissionId: 'empty', answer: '' }), code('VALIDATION_ERROR'));
    const record = await api.call('practice.submit', { generatedQuestionId: question._id,
      submissionId: 'open', answer: '一个合理的近义词', resultStatus: 'correct' });
    assert.equal(record.resultStatus, 'ungraded');
    await assert.rejects(api.call('practice.grade', { recordId: record._id, resultStatus: 'invalid' }), code('VALIDATION_ERROR'));
    for (const resultStatus of ['correct', 'wrong', 'ungraded']) {
      assert.equal((await api.call('practice.grade', { recordId: record._id, resultStatus })).resultStatus, resultStatus);
    }
    await api.call('generation.delete', { generatedQuestionId: question._id });
    await api.call('question.delete', { questionId: source._id });
    assert.equal((await api.call('practice.detail', { recordId: record._id })).questionSnapshot.questionText, question.questionText);
    await assert.rejects(api.call('student.delete', { studentId: student._id }), code('HAS_RELATED_DATA'));
    assert.equal((await api.call('practice.grade', { recordId: record._id, resultStatus: 'correct' })).resultStatus, 'correct');
  });

  test(`${mode}: restrict every new action to the current owner`, async () => {
    const { api, source, student } = await fixture(mode);
    const [question] = await api.call('generation.create', { sourceQuestionId: source._id });
    await api.call('generation.confirm', { generatedQuestionId: question._id });
    const record = await api.call('practice.submit', { generatedQuestionId: question._id, answer: '0', submissionId: 'owner' });
    api.switchUser('bob');
    for (const action of ['generation.list', 'practice.list', 'practice.records']) {
      assert.deepEqual(await api.call(action, { studentId: student._id }), []);
    }
    await assert.rejects(api.call('generation.create', { sourceQuestionId: source._id }), code('NOT_FOUND'));
    for (const action of ['generation.update', 'generation.confirm', 'generation.delete', 'practice.start', 'practice.submit']) {
      await assert.rejects(api.call(action, { generatedQuestionId: question._id, answer: '0', submissionId: 'other' }), code('NOT_FOUND'));
    }
    for (const action of ['practice.detail', 'practice.grade']) {
      await assert.rejects(api.call(action, { recordId: record._id, resultStatus: 'correct' }), code('NOT_FOUND'));
    }
  });

  test(`${mode}: all MVP demo templates return valid questions`, async () => {
    const { api, student } = await fixture(mode);
    for (const questionText of ['12 + 3 =', '24 - 7 =', '3 × 6 =', '48 ÷ 6 =']) {
      const source = await api.call('question.create', { studentId: student._id, subject: 'math', questionText });
      const questions = await api.call('generation.create', { sourceQuestionId: source._id, count: 3 });
      for (const question of questions) {
        const parts = question.questionText.split(' ');
        const a = Number(parts[0]);
        const b = Number(parts[2]);
        const expected = { '+': a + b, '-': a - b, '×': a * b, '÷': a / b }[parts[1]];
        assert.equal(Number(question.correctAnswer), expected);
      }
    }
    for (const data of [
      { subject: 'math', questionType: '应用题', questionText: '每盒有5支铅笔，3盒一共有多少支？' },
      { subject: 'chinese', questionText: '写出高的反义词' },
      { subject: 'chinese', questionText: '给山写拼音并组词' }
    ]) {
      const source = await api.call('question.create', { studentId: student._id, ...data });
      const questions = await api.call('generation.create', { sourceQuestionId: source._id, count: 3, difficulty: 3 });
      assert.ok(questions.every((question) => question.answerType === 'open' && question.analysis && question.correctAnswer));
    }
  });
}

test('AI boundary rejects malformed JSON, wrong count, stale version and empty analysis', () => {
  const source = { questionText: '2 + 2 =', version: 1 };
  const options = { count: 1, difficulty: 'normal' };
  const output = JSON.parse(domain.demoGenerate({ ...source, subject: 'math' }, options));
  for (const raw of ['bad JSON', { sourceVersion: 'wrong', questions: [] },
    { sourceVersion: domain.sourceVersion(source), questions: [] },
    { sourceVersion: domain.sourceVersion(source), questions: [{ ...output.questions[0], analysis: '' }] }]) {
    assert.throws(() => domain.validateOutput(raw, source, options), code('INVALID_AI_OUTPUT'));
  }
});

test('cloud generation rejects provider corruption and rolls back database failures', async () => {
  const { api, source } = await fixture('cloud');
  api.setAdapter(async () => 'malformed JSON');
  await assert.rejects(api.call('generation.create', { sourceQuestionId: source._id }), code('INVALID_AI_OUTPUT'));
  assert.deepEqual(api.inspect('generated_questions'), []);
  assert.equal(api.inspect('tasks')[0].status, 'failed');
  api.setAdapter(async (question, options) => domain.demoGenerate(question, options));
  api.failWrites();
  await assert.rejects(api.call('generation.create', { sourceQuestionId: source._id, count: 3 }));
  assert.deepEqual(api.inspect('generated_questions'), []);
  assert.ok(api.inspect('tasks').every((task) => task.status === 'failed'));
});
