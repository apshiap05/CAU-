# CAU 选课余量监控助手

面向中国农业大学正选阶段的课程余量查询与选课辅助工具。如果体育课、通识课等课程没有抽签中，可以在遵守学校规则的前提下，用它减少重复手动刷新。

项目提供两种安装方式：独立的 Google Chrome 扩展，以及兼容 Chrome、Edge、Firefox 的 Tampermonkey 用户脚本。两者复用浏览器中已经登录的教务会话和学校页面原生流程，不保存账号、密码或 Cookie。

> [!IMPORTANT]
> 本项目不能保证抢到课程，也不会绕过验证码、登录限制、选课时间、培养方案、时间冲突、课程组或其他教务规则。最终结果以学校教务系统为准。

## 选择版本

| 版本 | 适合场景 | 安装入口 |
| --- | --- | --- |
| Chrome 扩展 v1.1.0 | 只使用 Google Chrome，希望不依赖 Tampermonkey | [`chrome-extension/`](./chrome-extension/) |
| Tampermonkey 脚本 v1.3.0 | 使用 Chrome、Edge、Firefox，或已经安装 Tampermonkey | [`userscript/cau-course-watcher.user.js`](./userscript/cau-course-watcher.user.js) |

两个版本具备相同的核心能力：

- 按课程名自动填写并重复点击教务系统“查询”。
- 可按课程编号、教师、课序号、校区和时间关键词进一步过滤。
- 解析选课人数、限选人数和剩余容量。
- 多个班级同时有余量时，可选择页面第一班或余量最多的班。
- 发现余量后只提交一次，并调用页面原生 `xsxkFun(...)` 流程。
- 自动处理本次选课流程中的连续确认框，包括“确认选择当前课程班级”和后续课程组确认。
- 成功、验证码、会话失效、网络异常或结果不确定时，通过面板日志、提示音和桌面通知反馈。
- `Esc` 紧急停止、错误退避、最大查询次数和最低三秒间隔。

## 正常模式与多选模式

配置面板最上方提供两个选项卡：

- **正常模式**：保持原有行为，只查询和监控一门课程。
- **多选模式**：使用“＋”增加待选课程块、使用“−”删除多余课程，最少 1 门、最多 4 门。每门课程均可独立填写课程名称、匹配方式、课程编号、教师、课序号、校区、时间关键词、最低余量和多班选择策略。

多选监控按 `课程 1 → 课程 2 → 课程 3 → 课程 4 → 课程 1` 循环。程序每次只把当前课程名写入教务页面并点击一次“查询”，等待共享刷新间隔和随机抖动后再查询下一门。任何一门发现符合条件的余量都会立即进入原生选课流程；选课成功后整个监控停止。

刷新间隔、随机抖动、最大查询次数、显示已满课程、弹窗确认、桌面通知和提示音是全部课程共用的设置，只需在所有课程块下方填写一次。最大查询次数按全部课程的实际查询次数合计，而不是每门分别计算。

从旧版本升级时，原来的单课程配置会自动迁移为“正常模式”的第一门课程，不需要重新填写；新增的课程块和模式选择会继续保存在各自版本原有的本地配置存储中。

## 快速安装

### Google Chrome 扩展

1. 下载仓库源码：点击 GitHub 页面右上方 `Code` → `Download ZIP`，然后完整解压。
2. 在 Chrome 地址栏打开 `chrome://extensions/`。
3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压后包含 [`chrome-extension/manifest.json`](./chrome-extension/manifest.json) 的 `chrome-extension` 文件夹。
6. 登录教务系统并刷新选课页面，页面右侧会出现配置面板。

详细说明见 [Chrome 扩展文档](./chrome-extension/README.md)。

### Tampermonkey 用户脚本

1. 从浏览器官方扩展商店安装 Tampermonkey。
2. 打开 [用户脚本源码](./userscript/cau-course-watcher.user.js)，复制全部内容。
3. 在 Tampermonkey 中选择“添加新脚本”，替换示例内容并保存。
4. 登录教务系统并刷新选课页面。

也可以打开 [Raw 用户脚本](https://raw.githubusercontent.com/apshiap05/CAU-/main/userscript/cau-course-watcher.user.js) 交给 Tampermonkey 识别安装。详细说明见 [用户脚本文档](./userscript/README.md)。

## 推荐使用流程

1. 在顶部选择“正常模式”或“多选模式”。多选模式可通过“＋”配置最多 4 门待选课程。
2. 输入完整课程名称。同名课程较多时，再填写教师、课序号或时间关键词。
3. 正常模式先点击“仅查询一次”；多选模式点击“仅轮询一轮”，按顺序核对每门课程。该按钮不会选课。
4. 保留“自动点击本次选课流程中的所有‘确定’弹窗”勾选。
5. 检查全部条件后，勾选黄色区域中的“本次授权”。该授权不会保存，刷新后必须重新勾选。
6. 点击“开始监控”。发现符合最低余量的班级后，程序只尝试提交一次。
7. 成功后到“选课结果查看及退选”或课表中再次确认。

建议使用默认的 5 秒查询间隔和随机抖动。更短的间隔并不保证更容易成功，反而可能触发服务器限流、会话异常或账号保护。

## 连续确认框处理

自动确认不是常驻的全页面点击器。程序只在目标课程参数经过校验、即将调用页面原生选课函数时，临时处理这一次调用产生的 `confirm` 和 `alert`：

1. 校验当前网址、通知单号、课程 ID、重修标识和课程表中的选课按钮。
2. 临时将本次流程出现的全部 `confirm` 处理为“确定”。
3. 记录每条确认文字和教务系统结果提示。
4. 调用结束或超时后恢复页面原始弹窗函数。
5. 再到“选课结果查看及退选”区域验证是否真正选中。

验证码、需要输入内容的窗口、自定义网页表单和时间冲突选择窗口不会被等价为“点击确定”；遇到这些情况程序会暂停并要求人工处理。

## 仓库结构

```text
.
├─ chrome-extension/                # Google Chrome Manifest V3 扩展
│  ├─ manifest.json
│  ├─ background.js                 # 权限校验、主页面原生选课调用、通知
│  ├─ content.js                    # 配置面板、查询、匹配、状态反馈
│  └─ popup.*                       # Chrome 工具栏入口
├─ userscript/
│  ├─ cau-course-watcher.user.js    # Tampermonkey 用户脚本
│  └─ README.md
├─ tests/                           # 多选轮询、弹窗链和面板预览测试
├─ .github/workflows/validate.yml   # JavaScript 与 Manifest 自动校验
├─ LICENSE
└─ README.md
```

## 本地校验

需要 Node.js 18 或更高版本：

```powershell
node --check chrome-extension/content.js
node --check chrome-extension/background.js
node --check chrome-extension/popup.js
node --check userscript/cau-course-watcher.user.js
node tests/background-smoke.test.cjs
node tests/multi-mode.test.cjs
```

测试只使用模拟配置和课程行，检查旧配置迁移、四门上限、循环轮询顺序、连续两层确认框、异步结果提示以及弹窗函数恢复，不会访问教务系统或提交真实选课。

## 隐私与免责声明

- 配置仅保存在 Tampermonkey 或 Chrome 扩展的本地存储中。
- 代码不包含账号、密码或 Cookie，也不会向第三方服务器发送课程配置和运行日志。
- 请勿把个人登录凭据提交到 Issue、日志、截图或源代码中。
- 使用者应自行确认学校的选课规则和网络使用要求，并承担使用风险。

本项目按 [Apache License 2.0](./LICENSE) 开源。
