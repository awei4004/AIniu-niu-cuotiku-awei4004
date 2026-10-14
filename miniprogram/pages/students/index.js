const api = require('../../services/api');

Page({
  data: {
    students: [],
    loading: true,
    editingId: '',
    formName: '',
    formGradeIndex: 0,
    gradeOptions: [1, 2, 3, 4, 5, 6],
    formError: '',
    saving: false
  },

  onLoad() {
    this.loadStudents();
  },

  loadStudents() {
    this.setData({ loading: true });
    Promise.all([api.call('student.list'), api.call('user.bootstrap')]).then(([students, overview]) => {
      this.setData({
        students: students.map((student) => Object.assign({}, student, {
          isCurrent: Boolean(overview.user && overview.user.currentStudentId === student._id),
          firstLetter: student.name.slice(0, 1)
        })),
        loading: false
      });
    }).catch((error) => {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    });
  },

  onNameInput(event) {
    this.setData({ formName: event.detail.value, formError: '' });
  },

  onGradeChange(event) {
    this.setData({ formGradeIndex: Number(event.detail.value), formError: '' });
  },

  startCreate() {
    this.setData({
      editingId: '',
      formName: '',
      formGradeIndex: 0,
      formError: ''
    });
  },

  startEdit(event) {
    const student = this.data.students.find((item) => item._id === event.currentTarget.dataset.id);
    if (!student) return;
    this.setData({
      editingId: student._id,
      formName: student.name,
      formGradeIndex: Math.max(0, Number(student.grade) - 1),
      formError: ''
    });
  },

  cancelEdit() {
    this.setData({ editingId: '', formError: '' });
  },

  saveStudent() {
    const name = String(this.data.formName || '').trim();
    if (!name) {
      this.setData({ formError: '请输入学生姓名' });
      return;
    }

    const payload = {
      name,
      grade: this.data.gradeOptions[this.data.formGradeIndex]
    };
    const wasEditing = Boolean(this.data.editingId);
    this.setData({ saving: true, formError: '' });
    const action = this.data.editingId ? 'student.update' : 'student.create';
    if (this.data.editingId) payload.studentId = this.data.editingId;

    api.call(action, payload).then(() => {
      this.setData({ saving: false, editingId: '', formName: '' });
      wx.showToast({ title: wasEditing ? '已更新' : '已添加', icon: 'success' });
      this.loadStudents();
    }).catch((error) => {
      this.setData({ saving: false, formError: error.message || '保存失败' });
    });
  },

  selectStudent(event) {
    const studentId = event.currentTarget.dataset.id;
    api.call('student.select', { studentId }).then(() => {
      wx.showToast({ title: '已切换', icon: 'success' });
      this.loadStudents();
    }).catch((error) => {
      wx.showToast({ title: error.message || '切换失败', icon: 'none' });
    });
  },

  deleteStudent(event) {
    const student = this.data.students.find((item) => item._id === event.currentTarget.dataset.id);
    if (!student) return;
    wx.showModal({
      title: '删除学生档案',
      content: `确认删除“${student.name}”吗？已有错题时需要先处理错题。`,
      confirmColor: '#d43828',
      success: (result) => {
        if (!result.confirm) return;
        api.call('student.delete', { studentId: student._id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadStudents();
        }).catch((error) => {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        });
      }
    });
  }
});
