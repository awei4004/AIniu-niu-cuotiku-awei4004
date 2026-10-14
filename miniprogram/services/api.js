const storage = require('../utils/storage');

function getAppState() {
  try {
    return getApp().globalData || {};
  } catch (error) {
    return {};
  }
}

function call(action, data = {}) {
  if (getAppState().cloudEnabled && wx.cloud) {
    return wx.cloud.callFunction({
      name: 'api',
      data: {
        action,
        data
      }
    }).then((response) => {
      const result = response.result || {};
      if (!result.ok) {
        const error = new Error(result.error && result.error.message || '请求失败');
        error.code = result.error && result.error.code || 'REQUEST_FAILED';
        throw error;
      }
      return result.data;
    });
  }

  return Promise.resolve().then(() => localCall(action, data));
}

function localCall(action, data) {
  const user = storage.ensureUser();

  if (action === 'user.bootstrap') {
    const students = storage.getStudents();
    const currentStudent = students.find((item) => item._id === user.currentStudentId) || null;
    return { user, currentStudent };
  }

  if (action === 'student.list') {
    return storage.getStudents();
  }

  if (action === 'student.create') {
    const name = String(data.name || '').trim();
    const grade = Number(data.grade);
    if (!name || !Number.isInteger(grade) || grade < 1 || grade > 6) {
      throw createError('VALIDATION_ERROR', '请填写学生姓名和正确的年级');
    }
    const students = storage.getStudents();
    const student = {
      _id: storage.makeId('student'),
      ownerId: user._id,
      name,
      grade,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    students.unshift(student);
    storage.saveStudents(students);
    if (!user.currentStudentId) {
      storage.saveUser(Object.assign({}, user, { currentStudentId: student._id }));
    }
    return student;
  }

  if (action === 'student.update') {
    const name = String(data.name || '').trim();
    const grade = Number(data.grade);
    if (!name || !Number.isInteger(grade) || grade < 1 || grade > 6) {
      throw createError('VALIDATION_ERROR', '请填写学生姓名和正确的年级');
    }
    const students = storage.getStudents();
    const index = students.findIndex((item) => item._id === data.studentId && item.ownerId === user._id);
    if (index < 0) throw createError('NOT_FOUND', '学生不存在');
    students[index] = Object.assign({}, students[index], { name, grade, updatedAt: Date.now() });
    storage.saveStudents(students);
    return students[index];
  }

  if (action === 'student.select') {
    const students = storage.getStudents();
    const target = students.find((item) => item._id === data.studentId && item.ownerId === user._id);
    if (!target) throw createError('NOT_FOUND', '学生不存在');
    storage.saveUser(Object.assign({}, user, { currentStudentId: target._id }));
    return target;
  }

  if (action === 'student.delete') {
    const students = storage.getStudents();
    const target = students.find((item) => item._id === data.studentId && item.ownerId === user._id);
    if (!target) throw createError('NOT_FOUND', '学生不存在');
    storage.saveStudents(students.filter((item) => item._id !== target._id));
    if (user.currentStudentId === target._id) {
      const next = students.find((item) => item._id !== target._id);
      storage.saveUser(Object.assign({}, user, { currentStudentId: next ? next._id : '' }));
    }
    return { deleted: true };
  }

  throw createError('NOT_FOUND', '暂不支持该操作');
}

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  call
};
