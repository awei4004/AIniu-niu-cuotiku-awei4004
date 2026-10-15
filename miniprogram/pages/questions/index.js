const api = require('../../services/api');

const SUBJECT_OPTIONS = [
  { value: '', label: '全部学科' },
  { value: 'chinese', label: '语文' },
  { value: 'math', label: '数学' }
];

Page({
  data: {
    user: null,
    students: [],
    currentStudent: null,
    selectedStudentId: '',
    studentPickerLabels: ['全部学生'],
    studentPickerIndex: 0,
    subjectOptions: SUBJECT_OPTIONS,
    subjectPickerIndex: 0,
    searchKeyword: '',
    questions: [],
    totalCount: 0,
    reviewCount: 0,
    loading: true
  },

  onShow() {
    this.loadData();
  },

  loadData() {
    this.setData({ loading: true });
    Promise.all([api.call('user.bootstrap'), api.call('student.list')]).then(([overview, students]) => {
      const currentId = overview.user && overview.user.currentStudentId || '';
      const currentStudent = students.find((item) => item._id === currentId) || overview.currentStudent || null;
      const selectedStudentId = this.data.selectedStudentId && students.some((item) => item._id === this.data.selectedStudentId)
        ? this.data.selectedStudentId
        : (currentStudent ? currentStudent._id : '');
      const studentPickerIndex = Math.max(0, students.findIndex((item) => item._id === selectedStudentId) + 1);
      this.setData({
        user: overview.user,
        students,
        currentStudent,
        selectedStudentId,
        studentPickerLabels: ['全部学生'].concat(students.map((item) => item.name)),
        studentPickerIndex,
        loading: false
      });
      return this.loadQuestions(false);
    }).catch((error) => {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    });
  },

  loadQuestions(showLoading = true) {
    if (showLoading) this.setData({ loading: true });
    const subject = SUBJECT_OPTIONS[this.data.subjectPickerIndex].value;
    return api.call('question.list', {
      studentId: this.data.selectedStudentId,
      subject,
      keyword: this.data.searchKeyword
    }).then((questions) => {
      const visibleQuestions = questions.map((item) => Object.assign({}, item, {
        subjectLabel: item.subject === 'math' ? '数学' : '语文',
        masteryLabel: getMasteryLabel(item.mastery),
        difficultyLabel: getDifficultyLabel(item.difficulty),
        questionPreview: item.questionText.replace(/\s+/g, ' ').slice(0, 90)
      }));
      this.setData({
        questions: visibleQuestions,
        totalCount: visibleQuestions.length,
        reviewCount: visibleQuestions.filter((item) => item.mastery !== 'mastered').length,
        loading: false
      });
    }).catch((error) => {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '错题加载失败', icon: 'none' });
    });
  },

  onStudentFilterChange(event) {
    const index = Number(event.detail.value);
    const selectedStudentId = index === 0 ? '' : this.data.students[index - 1]._id;
    this.setData({ studentPickerIndex: index, selectedStudentId }, () => this.loadQuestions());
  },

  onSubjectChange(event) {
    this.setData({ subjectPickerIndex: Number(event.detail.value) }, () => this.loadQuestions());
  },

  onSearchInput(event) {
    this.setData({ searchKeyword: event.detail.value });
  },

  onSearchConfirm() {
    this.loadQuestions();
  },

  clearFilters() {
    this.setData({
      selectedStudentId: this.data.currentStudent ? this.data.currentStudent._id : '',
      studentPickerIndex: this.data.currentStudent ? this.data.students.findIndex((item) => item._id === this.data.currentStudent._id) + 1 : 0,
      subjectPickerIndex: 0,
      searchKeyword: ''
    }, () => this.loadQuestions());
  },

  openStudents() {
    wx.navigateTo({ url: '/pages/students/index' });
  },

  openCreate() {
    if (!this.data.students.length) {
      wx.showToast({ title: '请先添加学生档案', icon: 'none' });
      return;
    }
    const studentId = this.data.selectedStudentId || (this.data.currentStudent && this.data.currentStudent._id) || '';
    wx.navigateTo({ url: `/pages/questions/form${studentId ? `?studentId=${studentId}` : ''}` });
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/questions/detail?id=${event.currentTarget.dataset.id}` });
  },

  openExport() {
    wx.navigateTo({ url: `/pages/export/index${this.data.selectedStudentId ? '?studentId=' + this.data.selectedStudentId : ''}` });
  }
});

function getMasteryLabel(value) {
  return { new: '待复习', reviewing: '复习中', familiar: '较熟悉', mastered: '已掌握' }[value] || '待复习';
}

function getDifficultyLabel(value) {
  return { easy: '基础', normal: '一般', hard: '提高' }[value] || '一般';
}
