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
