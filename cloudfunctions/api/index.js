const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

exports.main = async (event = {}) => {
  const traceId = event.requestId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const wxContext = cloud.getWXContext();
    if (!wxContext.OPENID) {
      return failure('UNAUTHENTICATED', '无法确认当前用户', traceId);
    }

    const user = await ensureUser(wxContext.OPENID);
    const result = await dispatch(event.action, event.data || {}, user);
    return success(result, traceId);
  } catch (error) {
    console.error('[api]', traceId, error);
    return failure(error.code || 'INTERNAL_ERROR', publicMessage(error), traceId);
  }
};

async function dispatch(action, data, user) {
  switch (action) {
    case 'user.bootstrap':
      return bootstrap(user);
    case 'student.list':
      return listStudents(user);
    case 'student.create':
      return createStudent(user, data);
    case 'student.update':
      return updateStudent(user, data);
    case 'student.select':
      return selectStudent(user, data);
    case 'student.delete':
      return deleteStudent(user, data);
    case 'question.create':
      return createQuestion(user, data);
    case 'question.list':
      return listQuestions(user, data);
    case 'question.detail':
      return getOwnedQuestion(user, data.questionId);
    case 'question.update':
      return updateQuestion(user, data);
    case 'question.delete':
      return deleteQuestion(user, data);
    default:
      throw makeError('NOT_FOUND', '暂不支持该操作');
  }
}

async function ensureUser(openid) {
  const result = await db.collection('users').where({ openid }).limit(1).get();
  if (result.data.length) return result.data[0];
  const now = new Date();
  const created = await db.collection('users').add({
    data: {
      openid,
      displayName: '微信用户',
      currentStudentId: '',
      role: 'parent',
      createdAt: now,
      updatedAt: now
    }
  });
  return Object.assign({ _id: created._id }, created.data || {});
}

async function bootstrap(user) {
  let currentStudent = null;
  if (user.currentStudentId) {
    currentStudent = await getOwnedStudent(user, user.currentStudentId, false);
  }
  return { user: sanitizeUser(user), currentStudent };
}

async function listStudents(user) {
  const result = await db.collection('students')
    .where({ ownerId: user._id })
    .orderBy('createdAt', 'desc')
    .get();
  return result.data;
}

async function createStudent(user, data) {
  const fields = validateStudent(data);
  const now = new Date();
  const created = await db.collection('students').add({
    data: Object.assign({}, fields, {
      ownerId: user._id,
      createdAt: now,
      updatedAt: now
    })
  });
  const student = Object.assign({ _id: created._id }, fields, {
    ownerId: user._id,
    createdAt: now,
    updatedAt: now
  });
  if (!user.currentStudentId) {
    await db.collection('users').doc(user._id).update({
      data: { currentStudentId: student._id, updatedAt: now }
    });
  }
  return student;
}

async function updateStudent(user, data) {
  const fields = validateStudent(data);
  const current = await getOwnedStudent(user, data.studentId);
  const now = new Date();
  await db.collection('students').doc(current._id).update({
    data: Object.assign({}, fields, { updatedAt: now })
  });
  return Object.assign({}, current, fields, { updatedAt: now });
}

async function selectStudent(user, data) {
  const student = await getOwnedStudent(user, data.studentId);
  await db.collection('users').doc(user._id).update({
    data: { currentStudentId: student._id, updatedAt: new Date() }
  });
  return student;
}

async function deleteStudent(user, data) {
  const student = await getOwnedStudent(user, data.studentId);
  const related = await db.collection('wrong_questions')
    .where({ ownerId: user._id, studentId: student._id, deletedAt: _.exists(false) })
    .count();
  if (related.total > 0) {
    throw makeError('HAS_RELATED_DATA', '该学生已经有错题，暂时不能删除');
  }
  await db.collection('students').doc(student._id).remove();
  if (user.currentStudentId === student._id) {
    const next = await db.collection('students')
      .where({ ownerId: user._id })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    await db.collection('users').doc(user._id).update({
      data: {
        currentStudentId: next.data.length ? next.data[0]._id : '',
        updatedAt: new Date()
      }
    });
  }
  return { deleted: true };
}

async function createQuestion(user, data) {
  const fields = await validateQuestion(user, data);
  const now = new Date();
  const created = await db.collection('wrong_questions').add({
    data: Object.assign({}, fields, {
      ownerId: user._id,
      createdAt: now,
      updatedAt: now
    })
  });
  return Object.assign({ _id: created._id }, fields, {
    ownerId: user._id,
    createdAt: now,
    updatedAt: now
  });
}

async function listQuestions(user, data) {
  const query = { ownerId: user._id, deletedAt: _.exists(false) };
  if (data.studentId) query.studentId = data.studentId;
  if (data.subject) query.subject = data.subject;
  if (data.mastery) query.mastery = data.mastery;
  const result = await db.collection('wrong_questions')
    .where(query)
    .orderBy('createdAt', 'desc')
    .get();
  const keyword = String(data.keyword || '').trim().toLowerCase();
  if (!keyword) return result.data;
  return result.data.filter((item) => [item.questionText, item.chapter, item.analysis,
    item.errorReason, item.knowledgePoints].join(' ').toLowerCase().includes(keyword));
}

async function updateQuestion(user, data) {
  const current = await getOwnedQuestion(user, data.questionId);
  const fields = await validateQuestion(user, data);
  const now = new Date();
  await db.collection('wrong_questions').doc(current._id).update({
    data: Object.assign({}, fields, { updatedAt: now })
  });
  return Object.assign({}, current, fields, { updatedAt: now });
}

async function deleteQuestion(user, data) {
  const current = await getOwnedQuestion(user, data.questionId);
  const now = new Date();
  await db.collection('wrong_questions').doc(current._id).update({
    data: { deletedAt: now, updatedAt: now }
  });
  return { deleted: true };
}

async function getOwnedStudent(user, studentId, required = true) {
  if (!studentId) {
    if (required) throw makeError('VALIDATION_ERROR', '缺少学生 ID');
    return null;
  }
  const result = await db.collection('students')
    .where({ _id: studentId, ownerId: user._id })
    .limit(1)
    .get();
  if (!result.data.length) throw makeError('NOT_FOUND', '学生不存在');
  return result.data[0];
}

async function getOwnedQuestion(user, questionId) {
  if (!questionId) throw makeError('VALIDATION_ERROR', '缺少错题 ID');
  const result = await db.collection('wrong_questions')
    .where({ _id: questionId, ownerId: user._id, deletedAt: _.exists(false) })
    .limit(1)
    .get();
  if (!result.data.length) throw makeError('NOT_FOUND', '错题不存在');
  return result.data[0];
}

async function validateQuestion(user, data) {
  const studentId = String(data.studentId || '').trim();
  const subject = String(data.subject || '').trim();
  const questionText = String(data.questionText || '').trim();
  const student = await getOwnedStudent(user, studentId);
  if (!['chinese', 'math'].includes(subject)) throw makeError('VALIDATION_ERROR', '请选择语文或数学');
  if (!questionText || questionText.length > 5000) {
    throw makeError('VALIDATION_ERROR', '题目内容应为 1 至 5000 个字符');
  }
  const questionType = String(data.questionType || '').trim();
  const difficulty = String(data.difficulty || 'normal').trim();
  const mastery = String(data.mastery || 'new').trim();
  const allowedTypes = ['选择题', '填空题', '计算题', '应用题', '阅读题', '作文题', '其他'];
  const allowedDifficulties = ['easy', 'normal', 'hard'];
  const allowedMastery = ['new', 'reviewing', 'familiar', 'mastered'];
  if (questionType && !allowedTypes.includes(questionType)) throw makeError('VALIDATION_ERROR', '题型不正确');
  if (!allowedDifficulties.includes(difficulty)) throw makeError('VALIDATION_ERROR', '难度不正确');
  if (!allowedMastery.includes(mastery)) throw makeError('VALIDATION_ERROR', '掌握状态不正确');
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

function validateStudent(data) {
  const name = String(data.name || '').trim();
  const grade = Number(data.grade);
  if (!name || name.length > 20) throw makeError('VALIDATION_ERROR', '学生姓名长度应为 1 至 20 个字符');
  if (!Number.isInteger(grade) || grade < 1 || grade > 6) throw makeError('VALIDATION_ERROR', '请选择正确的年级');
  return { name, grade };
}

function sanitizeUser(user) {
  return {
    _id: user._id,
    displayName: user.displayName || '微信用户',
    currentStudentId: user.currentStudentId || '',
    role: user.role || 'parent',
    createdAt: user.createdAt
  };
}

function success(data, traceId) {
  return { ok: true, data, error: null, traceId };
}

function failure(code, message, traceId) {
  return { ok: false, data: null, error: { code, message }, traceId };
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicMessage(error) {
  if (error && error.code === 'HAS_RELATED_DATA') return error.message;
  if (error && ['VALIDATION_ERROR', 'NOT_FOUND', 'UNAUTHENTICATED'].includes(error.code)) return error.message;
  return '服务暂时不可用，请稍后重试';
}
