const USER_KEY = 'local_user';
const STUDENTS_KEY = 'local_students';

function getUser() {
  return wx.getStorageSync(USER_KEY) || null;
}

function saveUser(user) {
  wx.setStorageSync(USER_KEY, user);
  return user;
}

function getStudents() {
  return wx.getStorageSync(STUDENTS_KEY) || [];
}

function saveStudents(students) {
  wx.setStorageSync(STUDENTS_KEY, students);
  return students;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureUser() {
  const current = getUser();
  if (current) return current;
  return saveUser({
    _id: 'local-user',
    openid: 'local-openid',
    displayName: '本地演示用户',
    currentStudentId: '',
    createdAt: Date.now()
  });
}

module.exports = {
  getUser,
  saveUser,
  getStudents,
  saveStudents,
  makeId,
  ensureUser
};
