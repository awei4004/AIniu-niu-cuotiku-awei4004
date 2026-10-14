# 小学生语文数学错题知识库

这是一个原生微信小程序项目，当前已完成阶段一：项目骨架、学生管理、当前用户初始化和基础数据隔离接口。

## 用微信开发者工具打开

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 选择本项目目录 `D:\workplace\微信小程序期末作业`。
4. 如果暂时没有真实 AppID，可以先使用游客 AppID 运行界面和本地演示模式。
5. 编译后进入“我的”或首页右上角的学生入口，添加、编辑、切换和删除学生。

## 当前运行模式

项目默认是本地演示模式：

```text
miniprogram/config/env.js
```

```js
module.exports = {
  cloudEnvId: ''
};
```

`cloudEnvId` 为空时，学生数据保存在微信开发者工具的本地缓存中，适合没有云环境时演示阶段一。

配置真实云开发环境后，将其替换为云环境 ID：

```js
module.exports = {
  cloudEnvId: '你的云环境ID'
};
```

然后在微信开发者工具中：

1. 开通并选择云开发环境。
2. 创建 `users`、`students` 和 `wrong_questions` 数据库集合。阶段一暂时不会向 `wrong_questions` 写入错题，但学生删除保护会查询该集合。
3. 上传并部署 `cloudfunctions/api` 云函数，选择“云端安装依赖”。
4. 将数据库客户端权限设置为仅云函数可读写，业务接口中的归属校验负责区分用户。
5. 运行小程序并检查学生创建、切换和删除。

阶段一还没有错题记录，但删除学生前会检查 `wrong_questions` 是否存在关联数据，为阶段二的错题库提前保留数据边界。

## 阶段一文件

```text
project.config.json                 微信开发者工具项目配置
miniprogram/                        小程序前端
  pages/questions/                  错题库占位页
  pages/review/                     复习占位页
  pages/profile/                    我的页面
  pages/students/                   学生管理
  services/api.js                   云端/本地统一调用
  utils/storage.js                  本地演示存储
cloudfunctions/api/                 学生和用户云函数
tests/student-api.test.js           本地数据生命周期测试
scripts/check.js                    语法与微信模板编译检查
```

## 本地验证

在项目根目录运行：

```powershell
npm.cmd test
npm.cmd run check
```

`npm.cmd test` 验证本地学生生命周期和输入校验；`npm.cmd run check` 使用 Node 和微信开发者工具自带编译器检查 JavaScript、WXML 和 WXSS。

## 当前验收流程

```text
打开小程序
  → 进入学生管理
  → 添加“小明”、三年级
  → 编辑为四年级
  → 再添加“小红”、二年级
  → 切换当前学生
  → 删除“小红”
  → 返回首页确认当前学生
```

阶段二会在当前结构上增加手动错题录入、错题列表、详情、筛选和删除关联保护。
