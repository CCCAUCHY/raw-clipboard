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

        const versionName = this.metadata?.['version-name'] || (this.metadata?.version ? `v${this.metadata.version}` : 'v92');
        const group = new Adw.PreferencesGroup({
            title: `基础设置 (${versionName})\nGeneral Settings (${versionName})`,
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

        // 2. 界面语言切换按钮（中文 / English，默认中文，不读取系统语言环境）
        const langRow = new Adw.ActionRow({
            title: '界面语言\nInterface Language',
            subtitle: '历史记录弹窗内的按钮、提示与状态文本的显示语言（不读取系统语言环境，默认中文）\nDisplay language for buttons, tips, and status in clipboard popup (does not read system locale, defaults to Chinese)',
        });

        const langBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            css_classes: ['linked'],
            valign: Gtk.Align.CENTER,
        });

        const zhButton = new Gtk.ToggleButton({
            label: '中文',
        });
        const enButton = new Gtk.ToggleButton({
            label: 'English',
            group: zhButton,
        });

        langBox.append(zhButton);
        langBox.append(enButton);
        langRow.add_suffix(langBox);
        group.add(langRow);

        const currentLang = settings.get_string('ui-language');
        if (currentLang === 'en-US') {
            enButton.set_active(true);
        } else {
            zhButton.set_active(true);
        }

        zhButton.connect('toggled', () => {
            if (zhButton.active) {
                settings.set_string('ui-language', 'zh-CN');
            }
        });

        enButton.connect('toggled', () => {
            if (enButton.active) {
                settings.set_string('ui-language', 'en-US');
            }
        });

        const langChangedId = settings.connect('changed::ui-language', () => {
            const val = settings.get_string('ui-language');
            if (val === 'en-US') {
                if (!enButton.active) enButton.set_active(true);
            } else {
                if (!zhButton.active) zhButton.set_active(true);
            }
        });
        window.connect('unrealize', () => {
            try {
                settings.disconnect(langChangedId);
            } catch (_) {}
        });

        // 3. 最大历史记录限制配置项 (5 ~ 1000 项)
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
                subtitle: '使用方向键 ↑ / ↓ 移动选中条目（支持首尾循环），按 Enter 键、空格键或鼠标点击，将其注入系统剪贴板；键盘操作严格以屏幕当前选中的条目身份执行，即使后台新捕获条目也绝不错位。\nUse Arrow Keys ↑ / ↓ to navigate items (with wrap-around), press Enter, Space, or click to inject into the system clipboard; keyboard actions strictly bind to the visibly selected item identity against background concurrency.',
            },
            {
                title: '触控板手势与滚轮翻页\nTouchpad Gesture and Wheel Scroll',
                subtitle: '当历史超过 8 项时，支持触控板手势或鼠标滚轮翻页，亦可按方向键 ← / →（或 PageUp / PageDown）快速翻页：\n• 触控板单次划动锁步：双指轻划稳翻一页（One Swipe = Exactly One Page），彻底杜绝失控连翻；抬手或静止 180ms 即刻开启下一手势，滑动中反向立即响应；\n• 机械滚轮防抖：带齿物理鼠标滚轮一格一页，带 60ms 极速防抖；\n• 首尾循环翻页防误触：在第一页向上翻页或末页向下翻页时，首次操作不翻页并在页码左侧提示“循环？”，第二次同向操作才执行跨页并恢复正常页码。\nWhen history exceeds 8 items, use touchpad gestures or mouse wheel to flip pages, or press Arrow Keys ← / → (or PageUp / PageDown):\n• Touchpad Gesture Lockstep: single two-finger swipe flips exactly one page (One Swipe = Exactly One Page) preventing runaway scrolling; finger release or 180ms pause arms the next swipe with instant reversal response;\n• Mouse Wheel Debounced: notched wheel responds instantly with mechanical debounce;\n• Circular Paging Anti-Misoperation: scrolling up on the first page or down on the last page prompts "循环？" on the first trigger without flipping, and performs the page flip on the second consecutive trigger.',
            },
            {
                title: '多种排序方式\nMultiple Sort Modes',
                subtitle: '弹窗顶部提供 4 种排序切换方式（记录顺序、大小、类型、首字母），支持点击顶栏胶囊按钮或按 Tab 键（Shift+Tab 反向）循环切换：\n• 记录顺序：按条目复制时间排序，最新入队或重复复制项排在队首；\n• 大小：按数据容量字节大小由大到小降序排列；\n• 类型：按内容类型分组优先排列（文本优先，其次为复合/多类型、网页、文件、位图及未知类型）；\n• 首字母：英文条目按 A-Z 优先排列，非英文字符与其它语言排在英文后面并按记录顺序排列。\nTop bar provides 4 sorting modes (Record Order, Size, Type, Initial Letter), supporting click on top capsules or Tab (Shift+Tab) cycling:\n• Record Order: sorted by copy timestamp, newest items first;\n• Size: descending order by raw byte size;\n• Type: grouped by data type (text, composite/multi-type, html, files, image, unknown);\n• Initial Letter: English items sorted A-Z first, followed by others in record order.',
            },
            {
                title: '左侧类型按钮与多类型选择回灌\nType Buttons and Multi-Type Selection',
                subtitle: '条目左侧采用 48x48 扁平化正方形区域，直观展示数据格式；对于网页或办公软件复制的多类型条目（同时包含富文本 HTML 与纯文本），并排提供两个 48x48 正方形按钮：\n• 点击富文本图标：直接以 HTML 富文本格式回灌系统剪贴板，完整保留排版与样式；\n• 点击纯文本图标：直接换用纯文本类型标签回灌，轻松绕过终端或部分编辑器不收 HTML 的类型门禁；\n• 点击条目主体或按回车：以首选格式原样回灌。\nEach item features a 48x48 flat square button area on the left showing its data type; for multi-type items copied from browsers/office suites (containing both HTML and plain text), two side-by-side buttons are displayed:\n• Click Rich Text Icon: injects as HTML to preserve layout and styles;\n• Click Plain Text Icon: injects as plain text to bypass app gates that reject HTML;\n• Click Item Content or Press Enter: injects in the primary format.',
            },
            {
                title: '鼠标右键菜单 (带入搜索与复制文本)\nRight-Click Context Menu (Search & Copy Text)',
                subtitle: '在任意历史条目上点击鼠标右键即可弹出上下文菜单：\n• 带入搜索 (Search Preview)：将该条目预览内容的前 64 字符填入搜索框并立即检索；\n• 复制文本 (Copy Text)：对富文本、文件列表、未知类型等能以文本形式预览的条目开放，遵循“原样进出”原则直接换纯文本类型标签注入系统剪贴板，并在队首新增一条纯文本记录；\n• 边界保护：具备屏幕边缘防溢出处理，按 Esc 键或点击弹窗内外部空白处可优先安全关闭菜单。\nRight-click on any item to open the context menu:\n• Search Preview: fills the first 64 characters of the item preview into search bar for instant search;\n• Copy Text: available for rich text, file lists, and unknown types that preview as text; swaps type tag to text directly without destructive modification, preserving original data and injecting a text entry at the top;\n• Boundary Protection: protected against screen overflow; press Esc or click empty space to safely close.',
            },
            {
                title: '预览内搜索\nSearch Previews',
                subtitle: '在弹窗中直接键入任意字符，将自动唤出搜索栏替代排序选项卡，实时匹配文本、富文本、文件列表及未知类型的预览内容：\n• 关键字匹配：支持所有能以文本形式预览的项目，位图类型不参与匹配，结果以记录顺序排列；\n• 纯键盘直接响应：纯键盘驱动无光标，设 128 字符上限防止内存膨胀，彻底禁用输入法从根源杜绝候选框遮挡与首字母遗漏缺陷；\n• 列表导航：键入搜索时按 ↑ / ↓ 可直接在搜索结果列表中移动选择，Enter 确认恢复选中项并关闭弹窗；\n• 退出搜索：鼠标点击搜索栏自身、弹窗外任意区域、弹窗内非历史记录项目区域，或者按 Esc 键均可退出搜索状态回到完整列表；\n• 删光搜索词：BackSpace 删光字符时不会退出搜索状态，而是显示“无匹配项目”；\n• 循环翻页：搜索结果列表依然完整支持 PageUp / PageDown 循环翻页（同享首末页二次操作防误触保护）。\nType any character in the popup to automatically reveal the search bar replacing sort tabs, matching preview text in real-time:\n• Keyword Matching: searches preview content of all text-previewable items; results sorted in record order;\n• Pure Keyboard-Driven: disables IME to eliminate candidate window occlusion and first-letter-drop bugs, capped at 128 chars;\n• List Navigation: press ↑ / ↓ to navigate search results directly, Enter to restore and close popup;\n• Exit Search: click the search bar, click outside, click non-item areas, or press Esc to exit search mode;\n• Cleared Input: erasing all characters stays in search mode showing "No matching items";\n• Circular Pagination: search results fully support PageUp / PageDown circular pagination with the same anti-misoperation protection.',
            },
            {
                title: '未知类型原样保留与剪切拦截\nUnknown Types & Cut Protection',
                subtitle: '对 SVG、Office 专有格式或系统自定义未知类型，统一作为 raw 二进制流无损保留，在预览区原样展示其 MIME 类型标签字符串帮助识别，并开放搜索与复制文本；严格识别并拦截剪切文件（Ctrl+X），同时精准区分 KDE（标记 0）与 GNOME 的普通复制文件并放行入库。\nFor SVG, Office proprietary formats, or custom types, raw binary data is preserved losslessly, displaying their MIME type string in the preview area with search and copy text support; file cut operations (Ctrl+X) are intercepted while KDE (marker 0) and GNOME ordinary copies are safely permitted.',
            },
            {
                title: '复制时间\nCopy Timestamp',
                subtitle: '每个历史条目右侧均记录并显示复制那一刻的时间（当天显示时分秒，跨天显示 n天前 时分）；若重复复制相同内容，将自动更新其复制时间并提升至队首。\nEach item records and displays its exact copy timestamp on the right (HH:mm:ss for today, n days ago HH:mm for past days); duplicate copies automatically update their copy timestamp and promote to the top.',
            },
            {
                title: '删除条目与撤销\nDelete and Undo',
                subtitle: '点击条目右侧 48x48 扁平化正方形垃圾桶按钮，或选中后按 Delete / Backspace 键删除；操作严格绑定到屏幕当前可见选中的条目身份；误删可按 Ctrl+Z 快捷撤销。\nClick the 48x48 flat square trash button or press Delete / Backspace to remove; operations strictly bind to the visibly selected item identity against background concurrency; press Ctrl+Z to undo.',
            },
            {
                title: '关闭窗口\nClose Window',
                subtitle: '按 Esc 键或点击窗口外部任意区域即可随时关闭（若处于右键菜单或搜索状态，则优先退出菜单或搜索状态）。\nPress Esc or click outside the window to close at any time (exits context menu or search mode first if active).',
            },
            {
                title: '多语言切换\nLanguage Switch',
                subtitle: '本扩展完全不读取系统语言环境，保护隐私并保证行为确定；可在设置界面通过“界面语言”切换按钮随时在中文与英文间切换。\nThis extension does not read system locale at all for privacy and predictability; switch between Chinese and English anytime using the Interface Language toggle buttons in settings.',
            },
            {
                title: '隐私与安全保护\nPrivacy and Security',
                subtitle: '所有剪贴板内容仅保存在当前内存中，关机或注销自动销毁；复制文件时仅记录路径，不重复读取磁盘文件。\nAll clipboard contents are kept in memory only and destroyed on shutdown or logout; copying files records paths only with zero duplicate disk reads.',
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
