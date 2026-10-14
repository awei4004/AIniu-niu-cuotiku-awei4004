const test = require('node:test');
const assert = require('node:assert/strict');

const memory = new Map();
global.wx = {
  getStorageSync(key) {
    return memory.get(key);
  },
  setStorageSync(key, value) {
    memory.set(key, value);
  }
};
global.getApp = () => ({ globalData: { cloudEnabled: false } });

const api = require('../miniprogram/services/api');

test('stage one local student lifecycle keeps current student isolated', async () => {
  const created = await api.call('student.create', { name: '小明', grade: 3 });
  assert.equal(created.name, '小明');
  assert.equal(created.grade, 3);

  let overview = await api.call('user.bootstrap');
  assert.equal(overview.currentStudent._id, created._id);

  const updated = await api.call('student.update', {
    studentId: created._id,
    name: '小明同学',
    grade: 4
  });
  assert.equal(updated.name, '小明同学');
  assert.equal(updated.grade, 4);

  const second = await api.call('student.create', { name: '小红', grade: 2 });
  await api.call('student.select', { studentId: second._id });
  overview = await api.call('user.bootstrap');
  assert.equal(overview.currentStudent._id, second._id);

  const list = await api.call('student.list');
  assert.equal(list.length, 2);
  assert.ok(list.every((student) => student.ownerId === 'local-user'));

  await api.call('student.delete', { studentId: second._id });
  overview = await api.call('user.bootstrap');
  assert.equal(overview.currentStudent._id, created._id);
});

test('stage one rejects invalid student input', async () => {
  await assert.rejects(
    api.call('student.create', { name: '', grade: 3 }),
    (error) => error.code === 'VALIDATION_ERROR'
  );

  await assert.rejects(
    api.call('student.create', { name: '测试', grade: 7 }),
    (error) => error.code === 'VALIDATION_ERROR'
  );
});

test('stage two supports wrong question lifecycle and scoped filters', async () => {
  const student = await api.call('student.create', { name: '阶段二学生', grade: 3 });
  await api.call('student.select', { studentId: student._id });

  const mathQuestion = await api.call('question.create', {
    studentId: student._id,
    subject: 'math',
    questionType: '计算题',
    difficulty: 'normal',
    questionText: '23 × 14 =',
    studentAnswer: '332',
    correctAnswer: '322',
    errorReason: '进位时漏加',
    knowledgePoints: '两位数乘法'
  });
  const chineseQuestion = await api.call('question.create', {
    studentId: student._id,
    subject: 'chinese',
    questionText: '请用“虽然……但是……”造句',
    mastery: 'mastered'
  });

  let list = await api.call('question.list', { studentId: student._id });
  assert.equal(list.length, 2);
  assert.equal((await api.call('question.list', { subject: 'math' })).length, 1);
  assert.equal((await api.call('question.list', { keyword: '进位' })).length, 1);
  assert.equal((await api.call('question.list', { mastery: 'mastered' })).length, 1);

  const updated = await api.call('question.update', {
    questionId: mathQuestion._id,
    studentId: student._id,
    subject: 'math',
    questionText: '23 × 14 =',
    correctAnswer: '322',
    mastery: 'reviewing'
  });
  assert.equal(updated.mastery, 'reviewing');
  assert.equal((await api.call('question.detail', { questionId: mathQuestion._id })).mastery, 'reviewing');

  await assert.rejects(
    api.call('student.delete', { studentId: student._id }),
    (error) => error.code === 'HAS_RELATED_DATA'
  );

  await api.call('question.delete', { questionId: mathQuestion._id });
  list = await api.call('question.list', { studentId: student._id });
  assert.equal(list.length, 1);
  assert.equal(list[0]._id, chineseQuestion._id);
  await api.call('question.delete', { questionId: chineseQuestion._id });
  assert.deepEqual(await api.call('question.list', { studentId: student._id }), []);
  await api.call('student.delete', { studentId: student._id });
});

test('stage two rejects invalid question input and unknown student', async () => {
  const students = await api.call('student.list');
  const student = students[0];
  await assert.rejects(
    api.call('question.create', {
      studentId: student._id,
      subject: 'science',
      questionText: '不支持的学科'
    }),
    (error) => error.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    api.call('question.create', {
      studentId: 'other-user-student',
      subject: 'math',
      questionText: '不属于当前用户的学生'
    }),
    (error) => error.code === 'NOT_FOUND'
  );
});
