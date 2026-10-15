const USER_KEY = 'local_user';
const STUDENTS_KEY = 'local_students';
const QUESTIONS_KEY = 'local_wrong_questions';
const GENERATED_QUESTIONS_KEY = 'local_generated_questions';
const PRACTICE_RECORDS_KEY = 'local_practice_records';
const TASKS_KEY = 'local_tasks';
const FILES_KEY = 'local_files';

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

function getQuestions() {
  return wx.getStorageSync(QUESTIONS_KEY) || [];
}

function saveQuestions(questions) {
  wx.setStorageSync(QUESTIONS_KEY, questions);
  return questions;
}

function getGeneratedQuestions() {
  return wx.getStorageSync(GENERATED_QUESTIONS_KEY) || [];
}

function saveGeneratedQuestions(questions) {
  wx.setStorageSync(GENERATED_QUESTIONS_KEY, questions);
  return questions;
}

function getPracticeRecords() {
  return wx.getStorageSync(PRACTICE_RECORDS_KEY) || [];
}

function savePracticeRecords(records) {
  wx.setStorageSync(PRACTICE_RECORDS_KEY, records);
  return records;
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
  getQuestions,
  saveQuestions,
  getGeneratedQuestions,
  saveGeneratedQuestions,
  getPracticeRecords,
  savePracticeRecords,
  getTasks: () => wx.getStorageSync(TASKS_KEY) || [],
  saveTasks: (tasks) => wx.setStorageSync(TASKS_KEY, tasks),
  getFiles: () => wx.getStorageSync(FILES_KEY) || [],
  saveFiles: (files) => wx.setStorageSync(FILES_KEY, files),
  makeId,
  ensureUser
};
