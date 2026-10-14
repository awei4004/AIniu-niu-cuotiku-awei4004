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
    const related = storage.getQuestions().some((item) => item.ownerId === user._id
      && item.studentId === target._id && !item.deletedAt);
    if (related) throw createError('HAS_RELATED_DATA', '该学生已经有错题，暂时不能删除');
    storage.saveStudents(students.filter((item) => item._id !== target._id));
    if (user.currentStudentId === target._id) {
      const next = students.find((item) => item._id !== target._id);
      storage.saveUser(Object.assign({}, user, { currentStudentId: next ? next._id : '' }));
    }
    return { deleted: true };
  }

  if (action === 'question.create') {
    const fields = validateQuestion(data, user);
    const now = Date.now();
    const question = Object.assign({
      _id: storage.makeId('question'),
      ownerId: user._id,
      createdAt: now,
      updatedAt: now
    }, fields);
    const questions = storage.getQuestions();
    questions.unshift(question);
    storage.saveQuestions(questions);
    return question;
  }

  if (action === 'question.list') {
    const keyword = String(data.keyword || '').trim().toLowerCase();
    return storage.getQuestions()
      .filter((item) => item.ownerId === user._id && !item.deletedAt)
      .filter((item) => !data.studentId || item.studentId === data.studentId)
      .filter((item) => !data.subject || item.subject === data.subject)
      .filter((item) => !data.mastery || item.mastery === data.mastery)
      .filter((item) => !keyword || [item.questionText, item.chapter, item.analysis, item.errorReason,
        item.knowledgePoints].join(' ').toLowerCase().includes(keyword))
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
  }

  if (action === 'question.detail') {
    return getOwnedQuestion(storage.getQuestions(), user, data.questionId);
  }

  if (action === 'question.update') {
    const questions = storage.getQuestions();
    const current = getOwnedQuestion(questions, user, data.questionId);
    const fields = validateQuestion(data, user);
    const index = questions.findIndex((item) => item._id === current._id);
    questions[index] = Object.assign({}, current, fields, { updatedAt: Date.now() });
    storage.saveQuestions(questions);
    return questions[index];
  }

  if (action === 'question.delete') {
    const questions = storage.getQuestions();
    const current = getOwnedQuestion(questions, user, data.questionId);
    const index = questions.findIndex((item) => item._id === current._id);
    questions[index] = Object.assign({}, current, { deletedAt: Date.now(), updatedAt: Date.now() });
    storage.saveQuestions(questions);
    return { deleted: true };
  }

  throw createError('NOT_FOUND', '暂不支持该操作');
}

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateQuestion(data, user) {
  const studentId = String(data.studentId || '').trim();
  const subject = String(data.subject || '').trim();
  const questionText = String(data.questionText || '').trim();
  const student = storage.getStudents().find((item) => item._id === studentId && item.ownerId === user._id);
  if (!student) throw createError('NOT_FOUND', '学生不存在');
  if (!['chinese', 'math'].includes(subject)) throw createError('VALIDATION_ERROR', '请选择语文或数学');
  if (!questionText || questionText.length > 5000) {
    throw createError('VALIDATION_ERROR', '题目内容应为 1 至 5000 个字符');
  }
  const questionType = String(data.questionType || '').trim();
  const difficulty = String(data.difficulty || 'normal').trim();
  const mastery = String(data.mastery || 'new').trim();
  const allowedTypes = ['选择题', '填空题', '计算题', '应用题', '阅读题', '作文题', '其他'];
  const allowedDifficulties = ['easy', 'normal', 'hard'];
  const allowedMastery = ['new', 'reviewing', 'familiar', 'mastered'];
  if (questionType && !allowedTypes.includes(questionType)) throw createError('VALIDATION_ERROR', '题型不正确');
  if (!allowedDifficulties.includes(difficulty)) throw createError('VALIDATION_ERROR', '难度不正确');
  if (!allowedMastery.includes(mastery)) throw createError('VALIDATION_ERROR', '掌握状态不正确');
  return {
    studentId,
    subject,
    grade: student.grade,
    chapter: String(data.chapter || '').trim().slice(0, 100),
    questionType,
    questionText,
    studentAnswer: String(data.studentAnswer || '').trim().slice(0, 3000),
    correctAnswer: String(data.correctAnswer || '').trim().slice(0, 3000),
    analysis: String(data.analysis || '').trim().slice(0, 5000),
    errorReason: String(data.errorReason || '').trim().slice(0, 1000),
    knowledgePoints: String(data.knowledgePoints || '').trim().slice(0, 500),
    difficulty,
    mastery
  };
}

function getOwnedQuestion(questions, user, questionId) {
  const target = questions.find((item) => item._id === questionId && item.ownerId === user._id && !item.deletedAt);
  if (!target) throw createError('NOT_FOUND', '错题不存在');
  return target;
}

module.exports = {
  call
};
