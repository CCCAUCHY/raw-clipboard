import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class RawClipboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '通用 / General',
            icon_name: 'edit-copy-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: '基础设置\nGeneral Settings',
            description: '剪贴板历史仅保存在内存中，注销或重启后自动清空，保护隐私且零磁盘写入\nClipboard history is kept in memory only and cleared upon logout or reboot, protecting privacy with zero disk writes.',
        });
        page.add(group);

        // 1. 快捷键配置项（采用内嵌式交互按钮避免焦点丢失）
        const shortcutRow = new Adw.ActionRow({
            title: '快捷键\nShortcut',
            subtitle: '在鼠标指针旁边打开剪贴板历史记录窗口，或关闭该窗口\nOpen or close the clipboard history window next to the mouse pointer',
        });

        const shortcutButton = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });

        const resetButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: '恢复默认快捷键 (<Super>v)\nReset to default shortcut (<Super>v)',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        const updateButtonLabel = () => {
            const list = settings.get_strv('toggle-shortcut');
            const val = list.length > 0 ? list[0] : '';
            shortcutButton.set_label(val || '未设置 (点击录制) / Not set (Click to record)');
        };
        updateButtonLabel();

        // 快捷键录制逻辑
        let isRecording = false;
        let eventController = null;
        let keyHandlerId = 0;
        let releaseHandlerId = 0;

        const isModifierKey = (keyval) => {
            return (
                keyval === Gdk.KEY_Shift_L || keyval === Gdk.KEY_Shift_R ||
                keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R ||
                keyval === Gdk.KEY_Alt_L || keyval === Gdk.KEY_Alt_R ||
                keyval === Gdk.KEY_Super_L || keyval === Gdk.KEY_Super_R ||
                keyval === Gdk.KEY_Meta_L || keyval === Gdk.KEY_Meta_R ||
                keyval === Gdk.KEY_Hyper_L || keyval === Gdk.KEY_Hyper_R ||
                keyval === Gdk.KEY_Caps_Lock || keyval === Gdk.KEY_Num_Lock ||
                keyval === Gdk.KEY_Scroll_Lock ||
                keyval === Gdk.KEY_ISO_Level3_Shift || keyval === Gdk.KEY_ISO_Level5_Shift ||
                keyval === Gdk.KEY_Mode_switch
            );
        };

        const stopRecording = () => {
            if (!isRecording) return;
            isRecording = false;
            shortcutButton.remove_css_class('destructive-action');
            shortcutButton.add_css_class('suggested-action');
            updateButtonLabel();
            if (eventController) {
                if (keyHandlerId > 0) {
                    eventController.disconnect(keyHandlerId);
                    keyHandlerId = 0;
                }
                if (releaseHandlerId > 0) {
                    eventController.disconnect(releaseHandlerId);
                    releaseHandlerId = 0;
                }
                shortcutButton.remove_controller(eventController);
                eventController = null;
            }
        };

        shortcutButton.connect('clicked', () => {
            if (isRecording) {
                stopRecording();
                return;
            }

            isRecording = true;
            shortcutButton.remove_css_class('suggested-action');
            shortcutButton.add_css_class('destructive-action');
            shortcutButton.set_label('请按键... (Esc取消) / Press keys... (Esc to cancel)');

            eventController = new Gtk.EventControllerKey();
            shortcutButton.add_controller(eventController);

            keyHandlerId = eventController.connect('key-pressed', (_controller, keyval, keycode, state) => {
                const mask = state & Gtk.accelerator_get_default_mod_mask();

                // 1. 按 Esc: 取消录制并恢复原状
                if (keyval === Gdk.KEY_Escape) {
                    stopRecording();
                    return Gdk.EVENT_STOP;
                }

                // 2. 按 Backspace (无修饰键): 清空快捷键
                if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                    settings.set_strv('toggle-shortcut', []);
                    stopRecording();
                    return Gdk.EVENT_STOP;
                }

                // 3. 纯修饰键 (Super, Ctrl, Alt, Shift 等): 保持录制状态，等待用户按下组合键
                if (isModifierKey(keyval)) {
                    if (keyval === Gdk.KEY_Super_L || keyval === Gdk.KEY_Super_R) {
                        shortcutButton.set_label('Super + ... (Esc取消 / Cancel)');
                    } else if (keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R) {
                        shortcutButton.set_label('Ctrl + ... (Esc取消 / Cancel)');
                    } else if (keyval === Gdk.KEY_Alt_L || keyval === Gdk.KEY_Alt_R) {
                        shortcutButton.set_label('Alt + ... (Esc取消 / Cancel)');
                    } else if (keyval === Gdk.KEY_Shift_L || keyval === Gdk.KEY_Shift_R) {
                        shortcutButton.set_label('Shift + ... (Esc取消 / Cancel)');
                    }
                    return Gdk.EVENT_STOP;
                }

                // 4. 普通单字符键（无修饰键）不允许作为全局系统快捷键（防止日常打字冲突），Function 键 (F1~F35) 除外
                const isFunctionKey = (keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35);
                if (mask === 0 && !isFunctionKey) {
                    return Gdk.EVENT_STOP;
                }

                // 5. 计算加速键名称并保存
                const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                if (accel) {
                    settings.set_strv('toggle-shortcut', [accel]);
                    stopRecording();
                    return Gdk.EVENT_STOP;
                }

                return Gdk.EVENT_PROPAGATE;
            });

            releaseHandlerId = eventController.connect('key-released', (_controller, _keyval, _keycode, state) => {
                const mask = state & Gtk.accelerator_get_default_mod_mask();
                if (isRecording && mask === 0) {
                    shortcutButton.set_label('请按键... (Esc取消) / Press keys... (Esc to cancel)');
                }
            });
        });

        resetButton.connect('clicked', () => {
            stopRecording();
            settings.set_strv('toggle-shortcut', ['<Super>v']);
            updateButtonLabel();
        });

        const shortcutBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        shortcutBox.append(shortcutButton);
        shortcutBox.append(resetButton);
        shortcutRow.add_suffix(shortcutBox);
        group.add(shortcutRow);

        // 2. 最大历史记录限制配置项 (5 ~ 1000 项)
        const maxItemsRow = new Adw.SpinRow({
            title: '最大历史记录限制\nMax History Items Limit',
            subtitle: '当新的剪贴板历史记录生成或修改此限制时，若剪贴板历史记录数量超出此限制，则自动移除最早的一项记录。\n（范围：5 ~ 1000 项，默认 30 项）\nWhen a new clipboard entry is created or this limit is modified, if the number of entries exceeds this limit, the oldest entry is automatically removed.\n(Range: 5 ~ 1000 items, Default: 30 items)',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 1000,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('max-items'),
            }),
        });
        settings.bind('max-items', maxItemsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(maxItemsRow);

        // 3. 单项记录容量限制 (5 ~ 1024 MB)
        const maxSizeRow = new Adw.SpinRow({
            title: '单项记录容量限制 (MB)\nSingle Item Size Limit (MB)',
            subtitle: '若复制的数据超出此限制，则不会被记录。修改此限制时，自动移除所有超出此限制的记录。\n（范围：5 ~ 1024 MB，默认 50 MB）\nIf copied data exceeds this limit, it will not be recorded. When this limit is modified, all entries exceeding this limit are automatically removed.\n(Range: 5 ~ 1024 MB, Default: 50 MB)',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 1024,
                step_increment: 5,
                page_increment: 50,
                value: settings.get_int('max-size-mb'),
            }),
        });
        settings.bind('max-size-mb', maxSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(maxSizeRow);

        // 4. 所有记录容量限制 (50 ~ 4096 MB)
        const maxTotalSizeRow = new Adw.SpinRow({
            title: '所有记录容量限制 (MB)\nTotal Size Limit (MB)',
            subtitle: '本扩展使用字节级前缀复用式存储，当新的剪贴板历史记录生成或修改此限制时，若存储树总大小超出此限制，则自动移除最早的一项或多项记录，直到存储树总大小低于此限制。\n（范围：50 ~ 4096 MB，默认 1024 MB）\nThis extension uses byte-level prefix-sharing storage. When a new entry is created or this limit is modified, if total storage exceeds this limit, the oldest entries are automatically removed until storage is below this limit.\n(Range: 50 ~ 4096 MB, Default: 1024 MB)',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 4096,
                step_increment: 50,
                page_increment: 256,
                value: settings.get_int('max-total-size-mb'),
            }),
        });
        settings.bind('max-total-size-mb', maxTotalSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(maxTotalSizeRow);

        // 5. 缩略图最大分辨率护栏
        const maxThumbDimRow = new Adw.SpinRow({
            title: '图片预览最大尺寸限制 (像素)\nMax Image Preview Dimension Limit (px)',
            subtitle: '若图片的任意边长超出此限制，则不会显示预览图。修改此限制时，不会影响已生成的预览图。\n（范围：512 ~ 16384 像素，默认 4096 像素）\nIf any dimension of the image exceeds this limit, no thumbnail preview is displayed. Modifying this limit will not affect already generated previews.\n(Range: 512 ~ 16384 px, Default: 4096 px)',
            adjustment: new Gtk.Adjustment({
                lower: 512,
                upper: 16384,
                step_increment: 256,
                page_increment: 1024,
                value: settings.get_int('max-thumbnail-dimension'),
            }),
        });
        settings.bind('max-thumbnail-dimension', maxThumbDimRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(maxThumbDimRow);

        // 6. 开启日志配置项 (默认关闭，关闭时不打印任何输出)
        const loggingRow = new Adw.SwitchRow({
            title: '运行日志\nOperation Logs',
            subtitle: '向系统日志 (journalctl) 输出剪贴板捕获、淘汰和诊断信息，平时可关闭以保持静默\nOutput clipboard capture, eviction, and diagnostic info to system logs (journalctl); can be kept disabled for silence',
        });
        settings.bind('enable-logging', loggingRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(loggingRow);

        // 7. 超时保护配置项
        const guardGroup = new Adw.PreferencesGroup({
            title: '超时保护\nTimeout Protection',
            description: '防止后台应用程序在复制时卡死或响应缓慢导致剪贴板无响应\nPrevents clipboard freezes caused by background applications hanging or responding slowly during copying',
        });
        page.add(guardGroup);

        // 传输停滞超时 (秒)
        const inactivityTimeoutRow = new Adw.SpinRow({
            title: '传输停滞超时 (秒)\nInactivity Timeout (Seconds)',
            subtitle: '当系统剪贴板所有者向本扩展传输数据时，若传输停滞的时间超出此限制，则自动取消本次传输。修改此配置后，若下一次传输停滞的时间超出此限制，则自动取消本次传输。\n（范围：1 ~ 60 秒，默认 5 秒）\nWhen the system clipboard owner transfers data to this extension, if the transfer stalls for longer than this limit, the transfer is automatically canceled. After modifying this setting, if the next transfer stalls for longer than this limit, it is automatically canceled.\n(Range: 1 ~ 60 sec, Default: 5 sec)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('inactivity-timeout-sec'),
            }),
        });
        settings.bind('inactivity-timeout-sec', inactivityTimeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        guardGroup.add(inactivityTimeoutRow);

        // 总体传输超时 (秒)
        const overallTimeoutRow = new Adw.SpinRow({
            title: '总体传输超时 (秒)\nOverall Transfer Timeout (Seconds)',
            subtitle: '当系统剪贴板所有者向本扩展传输数据时，若传输的已用时间超出此限制，则自动取消本次传输。修改此配置后，若当前已用传输时间超出此限制，则自动取消本次传输。\n（范围：2 ~ 300 秒，默认 15 秒）\nWhen the system clipboard owner transfers data to this extension, if elapsed transfer time exceeds this limit, the transfer is automatically canceled. After modifying this setting, if currently elapsed transfer time exceeds this limit, the transfer is automatically canceled.\n(Range: 2 ~ 300 sec, Default: 15 sec)',
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 300,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('overall-timeout-sec'),
            }),
        });
        settings.bind('overall-timeout-sec', overallTimeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        guardGroup.add(overallTimeoutRow);

        // 8. 使用说明 (中文操作指南与快捷键)
        const guideGroup = new Adw.PreferencesGroup({
            title: '使用指南\nUser Guide',
            description: '快捷键与常用操作说明\nShortcuts and common operation instructions',
        });
        page.add(guideGroup);

        const guideRows = [
            {
                title: '选择与粘贴\nSelect and Paste',
                subtitle: '使用方向键 ↑ / ↓ 移动选中条目（支持首尾循环），按 Enter 键、空格键或鼠标点击，将其注入系统剪贴板。\nUse Arrow Keys ↑ / ↓ to navigate items (with wrap-around), press Enter, Space, or click to inject into the system clipboard.',
            },
            {
                title: '滚动与翻页\nScroll and Page',
                subtitle: '当历史超过 8 项时，使用鼠标滚轮上下滚动，或按方向键 ← / →（或 PageUp / PageDown）快速翻页；支持循环翻页，在第一页向上翻页可直达末页，在末页向下翻页可循环返回首页。\nWhen history exceeds 8 items, use mouse wheel to scroll, or press Arrow Keys ← / → (or PageUp / PageDown) to flip pages; supports circular paging where scrolling up on the first page jumps to the last page, and scrolling down on the last page loops back to the first page.',
            },
            {
                title: '多种排序方式\nMultiple Sort Modes',
                subtitle: '弹窗顶部提供 4 种排序切换方式（记录顺序、大小、类型、首字母），支持点击顶栏胶囊按钮或按 Tab 键（Shift+Tab 反向）循环切换：\n• 记录顺序：按条目复制时间排序，最新入队或重复复制项排在队首；\n• 大小：按数据容量字节大小由大到小降序排列；\n• 类型：按内容类型分组优先排列（文本优先，其次为网页、图片及自定义未知类型）；\n• 首字母：英文条目按 A-Z 优先排列，非英文字符与其它语言排在英文后面并按记录顺序排列。\nTop bar provides 4 sorting modes (Record Order, Size, Type, Initial Letter), supporting click on top capsules or Tab (Shift+Tab) cycling:\n• Record Order: sorted by copy timestamp, newest items first;\n• Size: descending order by raw byte size;\n• Type: grouped by data type (text, html, image, custom/unknown);\n• Initial Letter: English items sorted A-Z first, followed by others in record order.',
            },
            {
                title: '预览内搜索\nSearch Previews',
                subtitle: '在弹窗中直接键入任意字符，将自动唤出搜索栏替代排序选项卡，实时匹配文本、富文本和文件列表的预览内容：\n• 关键字匹配：仅对能以文本形式预览的项目按预览内容进行关键字搜索，结果按记录顺序排列；\n• 纯键盘直接响应：纯键盘驱动无光标，禁用输入法以彻底根除输入法候选框遮挡与首字母遗漏缺陷；\n• 剪贴板粘贴检索：支持按 Ctrl+V 直接粘贴剪贴板内容（支持中文及各类语言）进行即时检索；\n• 列表导航：键入搜索时，按 ↑ / ↓ 可直接在下方搜索结果列表中移动选择，Enter 确认恢复选中项并关闭弹窗；\n• 退出搜索：鼠标点击搜索栏自身、弹窗外任意区域、或弹窗内非历史记录项目区域，或者按 Esc 键，将退出搜索状态回到完整列表；\n• 删光搜索词：BackSpace 删光字符时不会退出搜索状态，而是显示“无匹配项目”；\n• 循环翻页：搜索结果列表依然完整支持 PageUp / PageDown 循环翻页。\nType any character in the popup to automatically reveal the search bar replacing sort tabs, matching preview text in real-time:\n• Keyword Matching: searches preview content of text, html, and file lists; results sorted in record order;\n• Pure Keyboard-Driven: disables IME to eliminate candidate window occlusion and GNOME first-letter-drop bugs;\n• Clipboard Paste Search: press Ctrl+V to paste any text (including Chinese) directly into search query;\n• List Navigation: press ↑ / ↓ to navigate search results directly, Enter to restore and close popup;\n• Exit Search: click the search bar, click outside, click non-item areas, or press Esc to exit search mode;\n• Cleared Input: erasing all characters stays in search mode showing "No matching items";\n• Circular Pagination: search results fully support PageUp / PageDown circular pagination.',
            },
            {
                title: '复制时间\nCopy Timestamp',
                subtitle: '每个历史条目右侧均记录并显示复制那一刻的时间（当天显示时分秒，跨天显示 n天前 时分）；若重复复制相同内容，将自动更新其复制时间并提升至队首。\nEach item records and displays its exact copy timestamp on the right (HH:mm:ss for today, n days ago HH:mm for past days); duplicate copies automatically update their copy timestamp and promote to the top.',
            },
            {
                title: '删除条目与撤销\nDelete and Undo',
                subtitle: '点击条目右侧的删除按钮，或选中后按 Delete / Backspace 键删除；误删可按 Ctrl+Z 快捷撤销\nClick the delete button on the right or press Delete / Backspace to remove; press Ctrl+Z to undo accidental deletion.',
            },
            {
                title: '关闭窗口\nClose Window',
                subtitle: '按 Esc 键或点击窗口外部任意区域即可随时关闭（若处于搜索状态，则优先退出搜索状态）\nPress Esc or click outside the window to close at any time (exits search mode first if active).',
            },
            {
                title: '隐私与安全保护\nPrivacy and Security',
                subtitle: '所有剪贴板内容仅保存在当前内存中，关机或注销自动销毁；复制文件时仅记录路径，不重复读取磁盘文件\nAll clipboard contents are kept in memory only and destroyed on shutdown or logout; copying files records paths only with zero duplicate disk reads.',
            },
        ];

        for (const item of guideRows) {
            const row = new Adw.ActionRow({
                title: item.title,
                subtitle: item.subtitle,
            });
            guideGroup.add(row);
        }
    }
}
