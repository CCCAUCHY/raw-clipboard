# Raw Clipboard (极简纯内存剪贴板管理器)

一个支持 GNOME Shell 51+ 的纯 GJS、零外部依赖、长青接口的极简剪贴板历史扩展。

## 设计特性
1. **零外部依赖 (Pure GJS)**：
   - 不依赖 `libgda`、SQLite、GSound 或任何外部后台守护进程，仅使用 GNOME 标准库（`Gio`、`GLib`、`St`、`Meta`、`Clutter`）。
2. **Raw 核心数据透传 (等价操作)**：
   - 捕获阶段：智能嗅探核心 MIME 类型（图片 `image/png`、文件列表 `text/uri-list`、纯文本 `text/plain`、富文本 `text/html` 等），直接保存无损原始字节流。
   - 回放阶段：原样调用 `St.Clipboard.set_content(..., mime, bytes)` 注入系统剪贴板，使粘贴行为与复制时完全等价。
3. **字节级前缀复用存储 (RadixRawTree)**：
   - 存储即查重，查重即存储。使用纯内存 Radix Raw 前缀树进行高密度复用存储，相同前缀字节流物理去重共享，超限自动 FIFO 级联淘汰。
4. **纯进程内存存储 (重启即清空)**：
   - 数据完全保留在 GNOME Shell 进程内存中，不写入磁盘，关机或注销时随进程退出自动销毁，保护隐私。
5. **快捷交互 (Super+V 鼠标指针浮动)**：
   - 默认通过 `Super+V` 唤出，窗口锚定在鼠标指针附近，带屏幕边缘防溢出处理；
   - 每页严格展示 8 项并显示底部居中页码；
   - 支持全键盘操作：`↑`/`↓` 步进、`←`/`→` 或 `PgUp`/`PgDn` 翻页、`Enter`/`Space` 恢复、`Delete`/`Backspace` 删除当前条目、`Ctrl+Z` 撤销删除、`Esc` 退出；
   - 支持鼠标操作：悬停高亮、滚轮翻页（带平滑防抖保护）、点击条目恢复、点击垃圾桶图标删除条目。
6. **双语设置界面规范 (Libadwaita)**：
   - 中英双语直观对照界面；
   - 快捷键录制、最大历史记录 (5 ~ 1000 项)、单条记录容量限制 (5 ~ 1024 MB)、所有记录容量限制 (50 ~ 4096 MB)、图片预览最大尺寸 (512 ~ 16384 像素)；
   - 超时保护（传输停滞超时、总体传输超时）；
   - 诊断日志开关（默认静默）。
7. **接口长青 (Stable & Evergreen)**：
   - 避开易变复杂的 QuickSettings 树，使用底层稳定的 St.Widget 浮动挂载，跨版本兼容性强。

---

## 安装

```bash
gnome-extensions install --force raw-clipboard@local.shell-extension.zip
gnome-extensions enable raw-clipboard@local
```

---

## 构建与测试

```bash
# 编译 Schema 并打包生成产物 zip
make pack

# 运行全套单元与边界压力自动化测试
make test
```

---

## 许可证 (License)

本项目采用 [GNU General Public License v3.0 or later (GPL-3.0-or-later)](LICENSE) 开源。
