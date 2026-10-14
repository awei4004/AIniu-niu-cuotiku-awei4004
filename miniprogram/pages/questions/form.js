const api = require('../../services/api');

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
    saving: false
  },

  onLoad(options) {
    this.setData({ questionId: options.id || '', isEditing: Boolean(options.id), initialStudentId: options.studentId || '' });
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
    this.setData({ subjectIndex: Number(event.detail.value), formError: '' });
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
      analysis: this.data.analysis
    };
    const action = this.data.isEditing ? 'question.update' : 'question.create';
    if (this.data.isEditing) payload.questionId = this.data.questionId;
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
    analysis: question.analysis || ''
  };
}
