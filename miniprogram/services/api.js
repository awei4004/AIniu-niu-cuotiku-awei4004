const storage = require('../utils/storage');
const domain = require('./practice-domain');

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
    const students = storage.getStudents().filter((item) => item.ownerId === user._id);
    const currentStudent = students.find((item) => item._id === user.currentStudentId) || null;
    return { user, currentStudent };
  }

  if (action === 'student.list') {
    return storage.getStudents().filter((item) => item.ownerId === user._id);
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
    const practiceRelated = storage.getGeneratedQuestions().some((item) => item.ownerId === user._id
      && item.studentId === target._id && item.status !== 'deleted')
      || storage.getPracticeRecords().some((item) => item.ownerId === user._id && item.studentId === target._id);
    if (related || practiceRelated) throw createError('HAS_RELATED_DATA', '该学生已有错题或复习记录，暂时不能删除');
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
      updatedAt: now,
      version: 1
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
    const contentChanged = ['studentId', 'subject', 'questionText', 'correctAnswer', 'analysis',
      'knowledgePoints', 'difficulty', 'questionType'].some((key) => current[key] !== fields[key]);
    questions[index] = Object.assign({}, current, fields, {
      updatedAt: Date.now(), version: (current.version || 1) + (contentChanged ? 1 : 0)
    });
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

  if (action === 'generation.create') {
    const source = getOwnedQuestion(storage.getQuestions(), user, data.sourceQuestionId);
    const options = domain.generationOptions(Object.assign({ difficulty: source.difficulty }, data));
    const task = { _id: storage.makeId('task'), ownerId: user._id, studentId: source.studentId,
      sourceQuestionId: source._id, sourceVersion: domain.sourceVersion(source),
      type: 'generation', provider: 'demo', status: 'running', createdAt: Date.now() };
    storage.saveTasks([task].concat(storage.getTasks()));
    let output;
    try {
      output = domain.validateOutput(domain.demoGenerate(source, options), source, options);
    } catch (error) {
      storage.saveTasks(storage.getTasks().map((item) => item._id === task._id
        ? Object.assign({}, item, { status: 'failed', error: error.message, updatedAt: Date.now() }) : item));
      throw error;
    }
    const generated = output.map((item) => Object.assign({
      _id: storage.makeId('generated'),
      ownerId: user._id,
      studentId: source.studentId,
      grade: source.grade,
      subject: source.subject,
      sourceQuestionId: source._id,
      sourceQuestionUpdatedAt: source.updatedAt,
      sourceVersion: domain.sourceVersion(source),
      taskId: task._id,
      provider: 'demo',
      status: 'draft',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }, item));
    const questions = storage.getGeneratedQuestions();
    storage.saveGeneratedQuestions(generated.concat(questions));
    storage.saveTasks(storage.getTasks().map((item) => item._id === task._id
      ? Object.assign({}, item, { status: 'completed', generatedQuestionIds: generated.map((q) => q._id), updatedAt: Date.now() }) : item));
    return generated;
  }

  if (action === 'generation.list') {
    return storage.getGeneratedQuestions()
      .filter((item) => item.ownerId === user._id && item.status !== 'deleted')
      .filter((item) => !data.sourceQuestionId || item.sourceQuestionId === data.sourceQuestionId)
      .filter((item) => !data.studentId || item.studentId === data.studentId)
      .filter((item) => !data.status || item.status === data.status)
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
  }

  if (action === 'generation.update') {
    const questions = storage.getGeneratedQuestions();
    const current = getOwnedGeneratedQuestion(questions, user, data.generatedQuestionId);
    const fields = domain.generatedFields(Object.assign({}, current, data));
    const index = questions.findIndex((item) => item._id === current._id);
    questions[index] = Object.assign({}, current, fields, {
      status: 'draft', updatedAt: Date.now(), version: (current.version || 1) + 1
    });
    storage.saveGeneratedQuestions(questions);
    return questions[index];
  }

  if (action === 'generation.confirm') {
    const questions = storage.getGeneratedQuestions();
    const current = getOwnedGeneratedQuestion(questions, user, data.generatedQuestionId);
    domain.generatedFields(current);
    domain.checkSource(current, getOwnedQuestion(storage.getQuestions(), user, current.sourceQuestionId));
    const index = questions.findIndex((item) => item._id === current._id);
    questions[index] = Object.assign({}, current, { status: 'confirmed', updatedAt: Date.now() });
    storage.saveGeneratedQuestions(questions);
    return questions[index];
  }

  if (action === 'generation.delete') {
    const questions = storage.getGeneratedQuestions();
    const current = getOwnedGeneratedQuestion(questions, user, data.generatedQuestionId);
    const index = questions.findIndex((item) => item._id === current._id);
    questions[index] = Object.assign({}, current, { status: 'deleted', updatedAt: Date.now() });
    storage.saveGeneratedQuestions(questions);
    return { deleted: true };
  }

  if (action === 'practice.list') {
    return storage.getGeneratedQuestions()
      .filter((item) => item.ownerId === user._id && item.status === 'confirmed')
      .filter((item) => !data.studentId || item.studentId === data.studentId)
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
      .map(domain.publicQuestion);
  }

  if (action === 'practice.start') {
    const generated = getOwnedGeneratedQuestion(storage.getGeneratedQuestions(), user, data.generatedQuestionId);
    if (generated.status !== 'confirmed') throw createError('INVALID_STATUS', '这道题还没有确认，不能进入练习');
    return domain.publicQuestion(generated);
  }

  if (action === 'practice.submit') {
    const answer = domain.answerText(data.answer);
    if (!data.submissionId || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.submissionId)) {
      throw createError('VALIDATION_ERROR', '缺少有效的提交编号');
    }
    const existing = storage.getPracticeRecords().find((item) => item.ownerId === user._id
      && item.submissionId === data.submissionId);
    if (existing) {
      if (existing.generatedQuestionId !== data.generatedQuestionId) throw createError('VALIDATION_ERROR', '提交编号已被使用');
      return existing;
    }
    const generated = getOwnedGeneratedQuestion(storage.getGeneratedQuestions(), user, data.generatedQuestionId);
    if (generated.status !== 'confirmed') throw createError('INVALID_STATUS', '这道题还没有确认，不能提交练习');
    if (data.questionVersion !== undefined && data.questionVersion !== (generated.version || 1)) {
      throw createError('QUESTION_CHANGED', '练习题已修改，请重新打开练习');
    }
    const resultStatus = domain.grade(generated, answer);
    const record = {
      _id: storage.makeId('practice'),
      ownerId: user._id,
      studentId: generated.studentId,
      generatedQuestionId: generated._id,
      submissionId: data.submissionId,
      resultStatus,
      answer,
      questionSnapshot: domain.snapshot(generated),
      submittedAt: Date.now()
    };
    const records = storage.getPracticeRecords();
    records.unshift(record);
    storage.savePracticeRecords(records);
    return record;
  }

  if (action === 'practice.records') {
    return storage.getPracticeRecords().filter((item) => item.ownerId === user._id)
      .filter((item) => !data.studentId || item.studentId === data.studentId)
      .sort((a, b) => b.submittedAt - a.submittedAt);
  }

  if (action === 'practice.detail' || action === 'practice.grade') {
    const records = storage.getPracticeRecords();
    const current = records.find((item) => item._id === data.recordId && item.ownerId === user._id);
    if (!current) throw createError('NOT_FOUND', '练习记录不存在');
    if (action === 'practice.detail') return current;
    const updated = Object.assign({}, current, { resultStatus: domain.gradeValue(current, data.resultStatus), gradedAt: Date.now() });
    storage.savePracticeRecords(records.map((item) => item._id === current._id ? updated : item));
    return updated;
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

function getOwnedGeneratedQuestion(questions, user, generatedQuestionId) {
  const target = questions.find((item) => item._id === generatedQuestionId
    && item.ownerId === user._id && item.status !== 'deleted');
  if (!target) throw createError('NOT_FOUND', '生成题不存在');
  return target;
}

module.exports = {
  call
};
