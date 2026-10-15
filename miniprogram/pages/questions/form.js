const api = require('../../services/api');
const images = require('../../services/image-client');
const storage = require('../../utils/storage');

const SUBJECT_OPTIONS = [
  { value: 'chinese', label: '语文' },
  { value: 'math', label: '数学' }
];
const QUESTION_TYPES = ['选择题', '填空题', '计算题', '应用题', '阅读题', '作文题', '其他'];
const DIFFICULTIES = [
  { value: 'easy', label: '基础' },
  { value: 'normal', label: '一般' },
  { value: 'hard', label: '提高' }
];
const MASTERY_OPTIONS = [
  { value: 'new', label: '待复习' },
  { value: 'reviewing', label: '复习中' },
  { value: 'familiar', label: '较熟悉' },
  { value: 'mastered', label: '已掌握' }
];

Page({
  data: {
    questionId: '',
    isEditing: false,
    students: [],
    studentLabels: [],
    studentIndex: 0,
    subjectOptions: SUBJECT_OPTIONS,
    subjectIndex: 0,
    questionTypes: ['不指定'].concat(QUESTION_TYPES),
    questionTypeIndex: 0,
    difficulties: DIFFICULTIES,
    difficultyIndex: 1,
    masteryOptions: MASTERY_OPTIONS,
    masteryIndex: 0,
    questionText: '',
    chapter: '',
    studentAnswer: '',
    correctAnswer: '',
    errorReason: '',
    knowledgePoints: '',
    analysis: '',
    formError: '',
    loading: true,
    saving: false,
    cloudMode: false, sourceFileId: '', imageUrl: '', imageError: '', imageBusy: false,
    uploadProgress: 0, uploadPending: false, ocrBusy: false, ocrUncertain: false,
    ocrStatus: '', ocrError: '', ocrText: '', candidateTaskId: '', candidateProvider: '',
    ocrTaskId: '', ocrReviewed: false, questionVersion: 1
  },

  onLoad(options) {
    this.saveRequestId = storage.makeId('question');
    this.setData({ questionId: options.id || '', isEditing: Boolean(options.id),
      initialStudentId: options.studentId || '', cloudMode: images.cloudEnabled() });
    this.loadForm(options.id || '', options.studentId || '');
  },

  loadForm(questionId, initialStudentId) {
    Promise.all([
      api.call('student.list'),
      api.call('user.bootstrap'),
      questionId ? api.call('question.detail', { questionId }) : Promise.resolve(null)
    ]).then(([students, overview, question]) => {
      const selectedStudentId = question ? question.studentId : (initialStudentId || (overview.user && overview.user.currentStudentId || ''));
      const studentIndex = Math.max(0, students.findIndex((item) => item._id === selectedStudentId));
      const nextData = {
        students,
        studentLabels: students.map((item) => item.name),
        studentIndex,
        loading: false
      };
      if (question) Object.assign(nextData, questionToForm(question, students));
      this.setData(nextData);
      if (nextData.sourceFileId) {
        this.refreshImage();
        this.ocrRequest = wx.getStorageSync(`ocr_recovery_${nextData.sourceFileId}`) || null;
        if (this.ocrRequest && this.ocrRequest.fileId === nextData.sourceFileId) this.recoverOcr();
      }
    }).catch((error) => {
      this.setData({ loading: false, formError: error.message || '加载失败' });
    });
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [field]: event.detail.value, formError: '' });
  },

  onStudentChange(event) {
    this.setData({ studentIndex: Number(event.detail.value), formError: '' });
  },

  onSubjectChange(event) {
    if (this.data.ocrBusy || this.data.ocrUncertain) return;
    this.setData({ subjectIndex: Number(event.detail.value), formError: '' });
  },

  choosePhoto(event) {
    if (this.data.imageBusy || this.data.ocrBusy || this.data.ocrUncertain || this.data.saving) return;
    this.setData({ imageBusy: true, imageError: '', uploadProgress: 0 });
    images.choose(event.currentTarget.dataset.source).then((selection) => {
      this.pendingImage = { selection, requestId: storage.makeId('upload'), state: {} };
      this.ocrRequest = null;
      this.setData({ imageUrl: selection.path, sourceFileId: '', uploadPending: true,
        ocrText: '', candidateTaskId: '', ocrTaskId: '', ocrReviewed: false, ocrStatus: '', ocrError: '' });
      return this.uploadImage();
    }).catch((error) => {
      if (!/cancel/.test(error.errMsg || '')) this.setData({ imageError: error.message || error.errMsg || '无法选择图片，请检查相册或相机权限' });
    }).finally(() => this.setData({ imageBusy: false }));
  },

  uploadImage() {
    const pending = this.pendingImage;
    return images.upload(pending.selection, { requestId: pending.requestId, state: pending.state,
      onProgress: (value) => this.setData({ uploadProgress: value }) }).then((file) => {
      this.setData({ sourceFileId: file._id, uploadPending: false, imageError: '' });
      this.pendingImage = null;
      return this.refreshImage();
    });
  },

  retryUpload() {
    if (!this.pendingImage || this.data.imageBusy || this.data.saving) return;
    this.setData({ imageBusy: true, imageError: '' });
    this.uploadImage().catch((error) => this.setData({ imageError: error.message || error.errMsg || '上传失败，请重试' }))
      .finally(() => this.setData({ imageBusy: false }));
  },

  refreshImage() {
    const fileId = this.data.sourceFileId;
    return api.call('file.access', { fileId }).then((result) => {
      if (this.data.sourceFileId === fileId) this.setData({ imageUrl: result.url, imageError: '' });
    }).catch((error) => {
      if (this.data.sourceFileId === fileId) this.setData({ imageError: error.message || '原图暂时无法预览' });
    });
  },

  onImageError(event) {
    if (event.currentTarget.dataset.src !== this.data.imageUrl) return;
    this.setData({ imageUrl: '', imageError: '原图加载失败，请重新加载或重新选择图片；仍可手动录入题目' });
  },

  retryImage() {
    if (this.data.sourceFileId && !this.data.imageBusy) return this.refreshImage();
  },

  previewImage() {
    const preview = () => wx.previewImage({ urls: [this.data.imageUrl],
      fail: () => this.setData({ imageError: '原图暂时无法预览，请重新加载或重新选择图片' }) });
    if (!this.data.sourceFileId) {
      if (this.data.imageUrl) preview();
      return;
    }
    this.refreshImage().then(() => {
      if (!this.data.imageError && this.data.imageUrl) preview();
    });
  },

  removeImage() {
    if (this.data.imageBusy || this.data.ocrBusy || this.data.ocrUncertain || this.data.saving) return;
    wx.showModal({ title: '移除原图', content: '确认从这道错题中移除原图？', success: (result) => {
      if (!result.confirm) return;
      this.pendingImage = null;
      this.ocrRequest = null;
      this.setData({ sourceFileId: '', imageUrl: '', imageError: '', uploadPending: false,
        ocrTaskId: '', ocrReviewed: false, ocrText: '', candidateTaskId: '', ocrError: '', ocrStatus: '' });
    } });
  },

  recognizeImage() {
    if (!this.data.sourceFileId || this.data.imageBusy || this.data.ocrBusy || this.data.saving) return;
    if (this.data.ocrUncertain) { this.recoverOcr(); return; }
    const start = () => {
      this.ocrRequest = { fileId: this.data.sourceFileId, subject: SUBJECT_OPTIONS[this.data.subjectIndex].value,
        requestId: storage.makeId('ocr') };
      wx.setStorageSync(`ocr_recovery_${this.data.sourceFileId}`, this.ocrRequest);
      this.setData({ ocrBusy: true, ocrError: '', ocrStatus: '正在识别' });
      api.call('ocr.recognize', this.ocrRequest).then((task) => this.acceptTask(task)).catch((error) => {
        if (['FILE_INVALID', 'NOT_FOUND', 'VALIDATION_ERROR', 'CONFLICT'].includes(error.code)) {
          this.setData({ ocrUncertain: false, ocrError: error.message, ocrStatus: '识别失败' });
        } else {
          this.setData({ ocrUncertain: true, ocrError: '请求结果尚未确认，请查询原任务；仍可手动保存', ocrStatus: '等待查询' });
        }
      }).finally(() => this.setData({ ocrBusy: false }));
    };
    if (this.data.cloudMode) {
      this.setData({ ocrBusy: true });
      wx.showModal({ title: '图片文字识别', content: '原图将提交至腾讯云文字识别服务。请确认图片可用于识别。',
        success: (result) => { if (result.confirm) start(); else this.setData({ ocrBusy: false }); },
        fail: () => this.setData({ ocrBusy: false }) });
    }
    else start();
  },

  recoverOcr() {
    if (!this.ocrRequest || this.data.ocrBusy) return;
    this.setData({ ocrBusy: true, ocrError: '' });
    api.call('task.get', { requestId: this.ocrRequest.requestId }).then((task) => this.acceptTask(task)).catch((error) => {
      if (error.code === 'NOT_FOUND') {
        // Reuse the original identifier even if the initial request arrives after this query.
        return api.call('ocr.recognize', this.ocrRequest).then((task) => this.acceptTask(task))
          .catch(() => this.setData({ ocrUncertain: true, ocrError: '原任务尚未恢复，请稍后再查；仍可手动保存' }));
      }
      else this.setData({ ocrUncertain: true, ocrError: error.message || '查询失败，请稍后再查' });
    }).finally(() => this.setData({ ocrBusy: false }));
  },

  acceptTask(task) {
    if (task.status === 'completed') {
      this.setData({ ocrUncertain: false, ocrStatus: task.result.provider === 'demo' ? '演示结果（非图片识别）' : '识别完成 · 待校对',
        ocrText: task.result.text, candidateTaskId: task._id, candidateProvider: task.result.provider, ocrError: '' });
    } else if (task.status === 'failed') {
      this.setData({ ocrUncertain: false, ocrStatus: '识别失败', ocrError: task.error });
    } else {
      this.setData({ ocrUncertain: true, ocrStatus: '识别进行中', ocrError: '任务仍在运行，请稍后查询' });
    }
  },

  changeOcrText(event) { this.setData({ ocrText: event.detail.value }); },

  applyOcr() {
    if (!this.data.ocrText.trim() || this.data.ocrBusy || this.data.saving) return;
    const apply = () => this.setData({ questionText: this.data.ocrText,
      ocrTaskId: this.data.candidateTaskId, ocrReviewed: true, ocrStatus: '已校对并填入题目' });
    if (this.data.questionText.trim() && this.data.questionText !== this.data.ocrText) {
      wx.showModal({ title: '替换题目内容', content: '题目已有文字，确认用校对后的识别文本替换？', success: (result) => { if (result.confirm) apply(); } });
    } else apply();
  },

  onQuestionTypeChange(event) {
    this.setData({ questionTypeIndex: Number(event.detail.value), formError: '' });
  },

  onDifficultyChange(event) {
    this.setData({ difficultyIndex: Number(event.detail.value), formError: '' });
  },

  onMasteryChange(event) {
    this.setData({ masteryIndex: Number(event.detail.value), formError: '' });
  },

  saveQuestion() {
    if (this.data.saving || this.data.loading || this.data.imageBusy || this.data.ocrBusy) return;
    if (this.data.uploadPending) { this.setData({ formError: '请重试图片上传，或移除图片后保存' }); return; }
    if (!this.data.students.length) {
      this.setData({ formError: '请先添加学生档案' });
      return;
    }
    if (!String(this.data.questionText || '').trim()) {
      this.setData({ formError: '请输入题目内容' });
      return;
    }
    const payload = {
      studentId: this.data.students[this.data.studentIndex]._id,
      subject: SUBJECT_OPTIONS[this.data.subjectIndex].value,
      questionType: this.data.questionTypeIndex ? this.data.questionTypes[this.data.questionTypeIndex] : '',
      difficulty: DIFFICULTIES[this.data.difficultyIndex].value,
      mastery: MASTERY_OPTIONS[this.data.masteryIndex].value,
      questionText: this.data.questionText,
      chapter: this.data.chapter,
      studentAnswer: this.data.studentAnswer,
      correctAnswer: this.data.correctAnswer,
      errorReason: this.data.errorReason,
      knowledgePoints: this.data.knowledgePoints,
      analysis: this.data.analysis,
      sourceFileId: this.data.sourceFileId, ocrTaskId: this.data.ocrTaskId, ocrReviewed: this.data.ocrReviewed
    };
    const action = this.data.isEditing ? 'question.update' : 'question.create';
    if (this.data.isEditing) Object.assign(payload, { questionId: this.data.questionId, expectedVersion: this.data.questionVersion });
    else payload.requestId = this.saveRequestId;
    this.setData({ saving: true, formError: '' });
    api.call(action, payload).then(() => {
      wx.showToast({ title: this.data.isEditing ? '已更新' : '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 350);
    }).catch((error) => {
      this.setData({ saving: false, formError: error.message || '保存失败' });
    });
  }
});

function questionToForm(question, students) {
  const difficultyIndex = Math.max(0, DIFFICULTIES.findIndex((item) => item.value === question.difficulty));
  const masteryIndex = Math.max(0, MASTERY_OPTIONS.findIndex((item) => item.value === question.mastery));
  const questionTypeIndex = Math.max(0, ['不指定'].concat(QUESTION_TYPES).findIndex((item) => item === question.questionType));
  return {
    studentIndex: Math.max(0, students.findIndex((item) => item._id === question.studentId)),
    subjectIndex: Math.max(0, SUBJECT_OPTIONS.findIndex((item) => item.value === question.subject)),
    questionTypeIndex,
    difficultyIndex,
    masteryIndex,
    questionText: question.questionText || '',
    chapter: question.chapter || '',
    studentAnswer: question.studentAnswer || '',
    correctAnswer: question.correctAnswer || '',
    errorReason: question.errorReason || '',
    knowledgePoints: question.knowledgePoints || '',
    analysis: question.analysis || '',
    sourceFileId: question.sourceFileId || '', ocrTaskId: question.ocrTaskId || '',
    ocrReviewed: question.ocrReviewed === true, questionVersion: question.version || 1
  };
}
