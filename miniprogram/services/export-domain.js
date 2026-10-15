const { error, requestId } = require('./image-domain');
const MAX_QUESTIONS = 20;
const MAX_PAGES = 60;
const TIMEOUT = 120000;

function options(data) {
  if (typeof data.studentId !== 'string' || !data.studentId || !Array.isArray(data.questionIds)
    || !data.questionIds.length || data.questionIds.length > MAX_QUESTIONS
    || data.questionIds.some((id) => typeof id !== 'string' || !id || id.length > 100)
    || new Set(data.questionIds).size !== data.questionIds.length) {
    throw error('VALIDATION_ERROR', '请选择同一学生的 1 至 20 道错题，不可重复');
  }
  if (!['practice', 'analysis'].includes(data.template)) throw error('VALIDATION_ERROR', '请选择练习版或解析版');
  const title = data.title === undefined ? '错题复习' : String(data.title).trim();
  const answerLines = data.answerLines === undefined ? 6 : Number(data.answerLines);
  if (!title || title.length > 40 || ![3, 6, 9].includes(answerLines)
    || data.includeImages !== undefined && typeof data.includeImages !== 'boolean') {
    throw error('VALIDATION_ERROR', '标题限 1 至 40 字，答题留白请选择 3、6 或 9 行');
  }
  return { studentId: data.studentId, questionIds: data.questionIds.slice(), template: data.template,
    title, answerLines, includeImages: data.template === 'analysis' && data.includeImages === true };
}

function snapshot(fields, student, questions) {
  if (!student || questions.length !== fields.questionIds.length
    || questions.some((q, i) => !q || q._id !== fields.questionIds[i] || q.studentId !== student._id || q.deletedAt)) {
    throw error('NOT_FOUND', '选中的错题不存在，或不属于当前学生，请重新选择');
  }
  const result = { title: fields.title, template: fields.template, answerLines: fields.answerLines,
    includeImages: fields.includeImages, student: { name: student.name, grade: student.grade },
    questions: questions.map((q) => {
      const item = { id: q._id, version: q.version || 1, subject: q.subject, questionType: q.questionType || '', questionText: q.questionText };
      if (fields.template === 'analysis') {
        for (const key of ['correctAnswer', 'studentAnswer', 'errorReason', 'knowledgePoints', 'analysis']) item[key] = q[key] || '';
        if (fields.includeImages && q.sourceFileId) item.sourceFileId = q.sourceFileId;
      }
      return item;
    }) };
  if (JSON.stringify(result).length > 80000) throw error('EXPORT_LIMIT', '本批内容较长，请减少题目数量后分批导出');
  return result;
}

function checkRequest(task, fields) {
  if (task.fingerprint !== JSON.stringify(fields)) throw error('CONFLICT', '该导出编号已用于另一份资料，请新建导出');
  return task;
}

function summary(task) {
  const { snapshot: content, fingerprint, ...rest } = task;
  return Object.assign(rest, { title: content.title, count: content.questions.length,
    template: content.template, studentName: content.student.name });
}

function failure(errorValue) {
  return ['FILE_INVALID', 'NOT_FOUND', 'EXPORT_LIMIT', 'PDF_FONT_MISSING', 'EXPORT_RUNTIME'].includes(errorValue.code)
    ? errorValue.message : 'PDF 生成失败，请重试；原错题仍可使用';
}

module.exports = { MAX_QUESTIONS, MAX_PAGES, TIMEOUT, error, requestId, options, snapshot, checkRequest, summary, failure };
