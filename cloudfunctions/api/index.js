const cloud = require('wx-server-sdk');
const domain = require('./practice-domain');
const aiAdapter = require('./ai-adapter');
const crypto = require('crypto');
const imageRules = require('./image-domain');
const ocrAdapter = require('./ocr-adapter');
const { createService } = require('./image-service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const _ = db.command;
const images = createService({ cloud, db, adapter: ocrAdapter });

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
  if (images.actions.includes(action)) return images.call(action, data, user);
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
    case 'generation.create':
      return createGeneration(user, data);
    case 'generation.list':
      return listGenerations(user, data);
    case 'generation.update':
      return updateGeneration(user, data);
    case 'generation.confirm':
      return confirmGeneration(user, data);
    case 'generation.delete':
      return deleteGeneration(user, data);
    case 'practice.list':
      return listPracticeQuestions(user, data);
    case 'practice.start':
      return startPractice(user, data);
    case 'practice.submit':
      return submitPractice(user, data);
    case 'practice.records':
      return listPracticeRecords(user, data);
    case 'practice.detail':
      return getOwnedRecord(user, data.recordId);
    case 'practice.grade':
      return gradePractice(user, data);
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
  return Object.assign({ _id: created._id }, { openid, currentStudentId: '', role: 'parent', createdAt: now });
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
  const generated = await db.collection('generated_questions')
    .where({ ownerId: user._id, studentId: student._id, status: _.neq('deleted') }).count();
  const records = await db.collection('practice_records')
    .where({ ownerId: user._id, studentId: student._id }).count();
  if (related.total > 0 || generated.total > 0 || records.total > 0) {
    throw makeError('HAS_RELATED_DATA', '该学生已有错题或复习记录，暂时不能删除');
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
  if (data.requestId !== undefined) {
    const requestId = imageRules.requestId(data.requestId);
    const id = crypto.createHash('sha256').update(JSON.stringify([user._id, 'question', requestId])).digest('hex');
    return db.runTransaction(async (transaction) => {
      const { data: existing } = await transaction.collection('wrong_questions').doc(id).get();
      if (existing) {
        if (existing.requestFingerprint !== JSON.stringify(fields)) throw makeError('CONFLICT', '该保存请求已完成，请返回错题库查看');
        return existing;
      }
      const document = Object.assign({}, fields, { ownerId: user._id, version: 1, requestId,
        requestFingerprint: JSON.stringify(fields), createdAt: now, updatedAt: now });
      await transaction.collection('wrong_questions').doc(id).set({ data: document });
      return Object.assign({ _id: id }, document);
    });
  }
  const created = await db.collection('wrong_questions').add({
    data: Object.assign({}, fields, {
      ownerId: user._id,
      version: 1,
      createdAt: now,
      updatedAt: now
    })
  });
  return Object.assign({ _id: created._id }, fields, {
    ownerId: user._id,
    version: 1,
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
  const fields = await validateQuestion(user, data, current);
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const { data: latest } = await transaction.collection('wrong_questions').doc(current._id).get();
    if (!latest || latest.ownerId !== user._id || latest.deletedAt) throw makeError('NOT_FOUND', '错题不存在');
    if (data.expectedVersion !== undefined && data.expectedVersion !== (latest.version || 1)) {
      throw makeError('CONFLICT', '错题已在其他页面修改，请重新打开后编辑');
    }
    const contentChanged = ['studentId', 'subject', 'questionText', 'correctAnswer', 'analysis',
      'knowledgePoints', 'difficulty', 'questionType', 'sourceFileId'].some((key) => (latest[key] || '') !== (fields[key] || ''));
    const version = (latest.version || 1) + (contentChanged ? 1 : 0);
    await transaction.collection('wrong_questions').doc(current._id).update({
      data: Object.assign({}, fields, { updatedAt: now, version })
    });
    return Object.assign({}, latest, fields, { updatedAt: now, version });
  });
}

async function deleteQuestion(user, data) {
  const current = await getOwnedQuestion(user, data.questionId);
  const now = new Date();
  await db.collection('wrong_questions').doc(current._id).update({
    data: { deletedAt: now, updatedAt: now }
  });
  return { deleted: true };
}

async function createGeneration(user, data) {
  const source = await getOwnedQuestion(user, data.sourceQuestionId);
  const options = domain.generationOptions(Object.assign({ difficulty: source.difficulty }, data));
  const now = new Date();
  const task = await db.collection('tasks').add({ data: {
    ownerId: user._id, studentId: source.studentId, sourceQuestionId: source._id,
    sourceVersion: domain.sourceVersion(source), type: 'generation', provider: aiAdapter.provider,
    status: 'running', createdAt: now, updatedAt: now
  } });
  try {
    const raw = await aiAdapter.generate(source, options);
    const generated = domain.validateOutput(raw, source, options);
    const results = generated.map((item) => Object.assign({}, item, {
      _id: `generated_${crypto.randomBytes(12).toString('hex')}`,
      ownerId: user._id, studentId: source.studentId, grade: source.grade, subject: source.subject,
      sourceQuestionId: source._id, sourceQuestionUpdatedAt: source.updatedAt,
      sourceVersion: domain.sourceVersion(source), taskId: task._id, provider: aiAdapter.provider,
      status: 'draft', version: 1, createdAt: now, updatedAt: now
    }));
    await db.runTransaction(async (transaction) => {
      const response = await transaction.collection('wrong_questions').doc(source._id).get();
      const current = response.data;
      if (!current || current.ownerId !== user._id || current.deletedAt) throw makeError('NOT_FOUND', '错题不存在');
      domain.checkSource({ sourceVersion: domain.sourceVersion(source) }, current);
      for (const item of results) {
        const fields = Object.assign({}, item);
        delete fields._id;
        await transaction.collection('generated_questions').doc(item._id).set({ data: fields });
      }
      await transaction.collection('tasks').doc(task._id).update({ data: {
        status: 'completed', generatedQuestionIds: results.map((item) => item._id), updatedAt: new Date()
      } });
    });
    return results;
  } catch (error) {
    await db.collection('tasks').doc(task._id).update({ data: {
      status: 'failed', error: publicMessage(error), updatedAt: new Date()
    } });
    throw error;
  }
}

async function listGenerations(user, data) {
  const query = { ownerId: user._id, status: data.status || _.neq('deleted') };
  if (data.sourceQuestionId) query.sourceQuestionId = data.sourceQuestionId;
  if (data.studentId) query.studentId = data.studentId;
  return readAll('generated_questions', query, 'createdAt');
}

async function updateGeneration(user, data) {
  await getOwnedGeneratedQuestion(user, data.generatedQuestionId);
  return db.runTransaction(async (transaction) => {
    const current = (await transaction.collection('generated_questions').doc(data.generatedQuestionId).get()).data;
    if (!current || current.ownerId !== user._id || current.status === 'deleted') throw makeError('NOT_FOUND', '生成题不存在');
    const fields = domain.generatedFields(Object.assign({}, current, data));
    const changes = Object.assign({}, fields, { status: 'draft', updatedAt: new Date(), version: (current.version || 1) + 1 });
    await transaction.collection('generated_questions').doc(current._id).update({ data: changes });
    return Object.assign({}, current, changes);
  });
}

async function confirmGeneration(user, data) {
  await getOwnedGeneratedQuestion(user, data.generatedQuestionId);
  return db.runTransaction(async (transaction) => {
    const current = (await transaction.collection('generated_questions').doc(data.generatedQuestionId).get()).data;
    if (!current || current.ownerId !== user._id || current.status === 'deleted') throw makeError('NOT_FOUND', '生成题不存在');
    domain.generatedFields(current);
    const source = (await transaction.collection('wrong_questions').doc(current.sourceQuestionId).get()).data;
    if (!source || source.ownerId !== user._id || source.deletedAt) throw makeError('NOT_FOUND', '错题不存在');
    domain.checkSource(current, source);
    const changes = { status: 'confirmed', updatedAt: new Date() };
    await transaction.collection('generated_questions').doc(current._id).update({ data: changes });
    return Object.assign({}, current, changes);
  });
}

async function deleteGeneration(user, data) {
  const current = await getOwnedGeneratedQuestion(user, data.generatedQuestionId);
  const now = new Date();
  await db.collection('generated_questions').doc(current._id).update({
    data: { status: 'deleted', updatedAt: now }
  });
  return { deleted: true };
}

async function listPracticeQuestions(user, data) {
  const query = { ownerId: user._id, status: 'confirmed' };
  if (data.studentId) query.studentId = data.studentId;
  return (await readAll('generated_questions', query, 'updatedAt')).map(domain.publicQuestion);
}

async function startPractice(user, data) {
  const current = await getOwnedGeneratedQuestion(user, data.generatedQuestionId);
  if (current.status !== 'confirmed') throw makeError('INVALID_STATUS', '这道题还没有确认，不能进入练习');
  return domain.publicQuestion(current);
}

async function submitPractice(user, data) {
  const answer = domain.answerText(data.answer);
  if (!data.submissionId || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.submissionId)) {
    throw makeError('VALIDATION_ERROR', '缺少有效的提交编号');
  }
  const id = crypto.createHash('sha256').update(`${user._id}:${data.submissionId}`).digest('hex');
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.collection('practice_records').doc(id).get();
    if (existing.data) {
      if (existing.data.generatedQuestionId !== data.generatedQuestionId) throw makeError('VALIDATION_ERROR', '提交编号已被使用');
      return existing.data;
    }
    if (!data.generatedQuestionId) throw makeError('VALIDATION_ERROR', '缺少生成题 ID');
    const current = (await transaction.collection('generated_questions').doc(data.generatedQuestionId).get()).data;
    if (!current || current.ownerId !== user._id || current.status === 'deleted') throw makeError('NOT_FOUND', '生成题不存在');
    if (current.status !== 'confirmed') throw makeError('INVALID_STATUS', '这道题还没有确认，不能提交练习');
    if (data.questionVersion !== undefined && data.questionVersion !== (current.version || 1)) {
      throw makeError('QUESTION_CHANGED', '练习题已修改，请重新打开练习');
    }
    const record = { ownerId: user._id, studentId: current.studentId, generatedQuestionId: current._id,
      submissionId: data.submissionId, answer, resultStatus: domain.grade(current, answer),
      questionSnapshot: domain.snapshot(current), submittedAt: new Date() };
    await transaction.collection('practice_records').doc(id).set({ data: record });
    return Object.assign({ _id: id }, record);
  });
}

async function readAll(collection, query, orderField) {
  const result = [];
  let page;
  do {
    page = await db.collection(collection).where(query).orderBy(orderField, 'desc').skip(result.length).limit(100).get();
    result.push(...page.data);
  } while (page.data.length === 100);
  return result;
}

async function listPracticeRecords(user, data) {
  const query = { ownerId: user._id };
  if (data.studentId) query.studentId = data.studentId;
  return readAll('practice_records', query, 'submittedAt');
}

async function getOwnedRecord(user, recordId) {
  if (!recordId) throw makeError('VALIDATION_ERROR', '缺少记录编号');
  const result = await db.collection('practice_records').where({ _id: recordId, ownerId: user._id }).limit(1).get();
  if (!result.data.length) throw makeError('NOT_FOUND', '练习记录不存在');
  return result.data[0];
}

async function gradePractice(user, data) {
  const record = await getOwnedRecord(user, data.recordId);
  const fields = { resultStatus: domain.gradeValue(record, data.resultStatus), gradedAt: new Date() };
  await db.collection('practice_records').doc(record._id).update({ data: fields });
  return Object.assign({}, record, fields);
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

async function getOwnedGeneratedQuestion(user, generatedQuestionId) {
  if (!generatedQuestionId) throw makeError('VALIDATION_ERROR', '缺少生成题 ID');
  const result = await db.collection('generated_questions')
    .where({ _id: generatedQuestionId, ownerId: user._id })
    .limit(1)
    .get();
  if (!result.data.length || result.data[0].status === 'deleted') throw makeError('NOT_FOUND', '生成题不存在');
  return result.data[0];
}

async function validateQuestion(user, data, current = {}) {
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
  return Object.assign({
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
  }, await images.questionImage(user, data, current));
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
  if (error && ['VALIDATION_ERROR', 'NOT_FOUND', 'UNAUTHENTICATED', 'INVALID_STATUS',
    'SOURCE_CHANGED', 'QUESTION_CHANGED', 'UNSUPPORTED_GENERATION', 'INVALID_AI_OUTPUT',
    'FILE_INVALID', 'CONFLICT'].includes(error.code)) return error.message;
  return '服务暂时不可用，请稍后重试';
}
