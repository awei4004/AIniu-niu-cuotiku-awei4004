const api = require('../../services/api');
const resultLabels = { correct: '答对', wrong: '答错', ungraded: '待判定' };

Page({
  data: {
    students: [], studentLabels: [], studentIndex: 0, studentId: '',
    questions: [], records: [], drafts: [], view: 'questions', loading: true, error: ''
  },
  onShow() { this.loadData(); },
  loadData() {
    this.setData({ loading: true, error: '' });
    return Promise.all([api.call('user.bootstrap'), api.call('student.list')]).then(([overview, students]) => {
      const selected = students.find((item) => item._id === this.data.studentId)
        || students.find((item) => item._id === overview.user.currentStudentId) || students[0];
      this.setData({ students, studentLabels: students.map((item) => item.name),
        studentIndex: Math.max(0, students.findIndex((item) => selected && item._id === selected._id)),
        studentId: selected ? selected._id : '' });
      return this.loadPractice();
    }).catch((error) => this.setData({ loading: false, error: error.message }));
  },
  loadPractice() {
    if (!this.data.studentId) {
      this.setData({ questions: [], records: [], drafts: [], loading: false });
      return Promise.resolve();
    }
    this.setData({ loading: true, error: '' });
    const filter = { studentId: this.data.studentId };
    return Promise.all([api.call('practice.list', filter), api.call('practice.records', filter),
      api.call('generation.list', Object.assign({}, filter, { status: 'draft' }))])
      .then(([questions, records, drafts]) => {
        this.setData({ questions, drafts, records: records.map((item) => Object.assign({}, item, {
          resultLabel: resultLabels[item.resultStatus], timeLabel: formatTime(item.submittedAt)
        })), loading: false });
      }).catch((error) => this.setData({ loading: false, error: error.message }));
  },
  changeStudent(event) {
    const index = Number(event.detail.value);
    this.setData({ studentIndex: index, studentId: this.data.students[index]._id });
    this.loadPractice();
  },
  changeView(event) { this.setData({ view: event.currentTarget.dataset.view }); },
  start(event) { wx.navigateTo({ url: `/pages/practice/index?id=${event.currentTarget.dataset.id}` }); },
  openRecord(event) { wx.navigateTo({ url: `/pages/practice/index?recordId=${event.currentTarget.dataset.id}` }); },
  openDraft(event) { wx.navigateTo({ url: `/pages/generation/index?sourceQuestionId=${event.currentTarget.dataset.source}` }); },
  openQuestions() { wx.switchTab({ url: '/pages/questions/index' }); },
  openStudents() { wx.navigateTo({ url: '/pages/students/index' }); }
});

function formatTime(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
