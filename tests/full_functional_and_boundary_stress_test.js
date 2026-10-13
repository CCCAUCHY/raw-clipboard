import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';

// ============================================================================
// 1. 测试环境初始化与 GNOME Shell / Clutter Mock 装配
// ============================================================================

// 注册系统与自定义 GResource
const extResource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
extResource._register();

const testDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const localGResource = GLib.build_filenamev([testDir, 'mock.gresource']);
const tmpGResource = '/tmp/frosted-wallpaper/tests/mock.gresource';
const mockResource = Gio.Resource.load(
    GLib.file_test(localGResource, GLib.FileTest.EXISTS) ? localGResource : tmpGResource
);
mockResource._register();

// Clutter & St UI Mock 组件库 (用于在无桌面渲染环境脱壳测试 Extension UI 生命周期)
class MockActor {
    constructor(props = {}) {
        Object.assign(this, props);
        this.children = [];
        this.scale_x = 1.0;
        this.scale_y = 1.0;
        this.opacity = 255;
        this.style_classes = [];
        this.signals = new Map();
        this.visible = true;
        this.reactive = props.reactive !== undefined ? props.reactive : true;
        this.x = props.x || 0;
        this.y = props.y || 0;
        this.width = props.width || 0;
        this.height = props.height || 0;
        if (props.child) {
            props.child.parent = this;
            this.children.push(props.child);
        }
    }
    add_child(c) {
        if (c) {
            c.parent = this;
            this.children.push(c);
        }
    }
    remove_child(c) {
        const idx = this.children.indexOf(c);
        if (idx >= 0) {
            c.parent = null;
            this.children.splice(idx, 1);
        }
    }
    destroy() {
        this.children = [];
    }
    destroy_all_children() {
        this.children = [];
    }
    get_children() {
        return this.children;
    }
    connect(sig, cb) {
        if (!this.signals.has(sig)) this.signals.set(sig, []);
        this.signals.get(sig).push(cb);
        return this.signals.get(sig).length;
    }
    disconnect() {}
    emit(sig, ...args) {
        if (this.signals.has(sig)) {
            for (const cb of this.signals.get(sig)) {
                const res = cb(this, ...args);
                if (res === Clutter.EVENT_STOP) return res;
            }
        }
    }
    set_position(x, y) { this.x = x; this.y = y; }
    set_size(w, h) { this.width = w; this.height = h; }
    set_pivot_point(px, py) { this.pivot_x = px; this.pivot_y = py; }
    ease(opts) {
        if (opts && typeof opts.onComplete === 'function') opts.onComplete();
    }
    get_position() { return [this.x || 0, this.y || 0]; }
    get_size() { return [this.width || 0, this.height || 0]; }
    get_transformed_position() {
        let curX = this.x || 0;
        let curY = this.y || 0;
        let p = this.parent;
        while (p) {
            curX += (p.x || 0);
            curY += (p.y || 0);
            p = p.parent;
        }
        return [curX, curY];
    }
    get_transformed_size() {
        return [this.width || 0, this.height || 0];
    }
    get_preferred_width(_forHeight) { return [this.width || 0, this.width || 52]; }
    get_preferred_height(_forWidth) { return [this.height || 0, this.height || 26]; }
    get_allocation_box() { return { x1: 0, y1: this.y || 0, x2: this.width || 0, y2: (this.y || 0) + (this.height || 48) }; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    contains(actor) {
        let cur = actor;
        while (cur) {
            if (cur === this) return true;
            cur = cur.parent;
        }
        return false;
    }
    add_style_class_name(c) {
        if (!this.style_classes.includes(c)) this.style_classes.push(c);
    }
    remove_style_class_name(c) {
        this.style_classes = this.style_classes.filter(x => x !== c);
    }
}

class MockLabel extends MockActor {
    constructor(props = {}) {
        super(props);
        this.text = props.text || '';
        this.clutter_text = { use_markup: false, ellipsize: 0, line_alignment: 0 };
    }
    set_text(t) {
        this.text = t;
    }
}

class MockIcon extends MockActor {
    constructor(props = {}) {
        super(props);
        this.gicon = props.gicon;
        this.icon_name = props.icon_name;
        this.icon_size = props.icon_size;
    }
}

class MockScrollView extends MockActor {
    constructor(props = {}) {
        super(props);
        this._vadj = {
            clamp_page: () => {},
            set_value: () => {},
            get_value: () => 0,
            lower: 0,
            upper: 100,
            page_size: 10,
            step_increment: 48,
        };
    }
    get_vadjustment() {
        return this._vadj;
    }
}

class MockBoxLayout extends MockActor {
    constructor(props = {}) {
        if (props && props.spacing !== undefined) {
            throw new Error('No property spacing on StBoxLayout');
        }
        super(props);
    }
}

class MockEntry extends MockActor {
    constructor(props = {}) {
        super(props);
        this.text = props.text || '';
        this.clutter_text = {
            use_markup: false,
            set_cursor_position: () => {},
        };
    }
    set_text(t) {
        this.text = t;
    }
    get_text() {
        return this.text;
    }
}

// 设置 Mock 类
Clutter.Actor = MockActor;
St.BoxLayout = MockBoxLayout;
St.Button = MockActor;
St.ScrollView = MockScrollView;
St.Label = MockLabel;
St.Icon = MockIcon;
St.Entry = MockEntry;
St.Settings = { get: () => ({ reducedMotion: 0 }) };
St.ReducedMotion = { REDUCE: 1 };
St.PolicyType = { NEVER: 0, AUTOMATIC: 1 };

globalThis.global = {
    display: {
        get_selection: () => ({
            connect: () => 1,
            disconnect: () => {},
            set_owner: (_type, source) => {
                globalThis._lastOwnedSource = source;
            },
        }),
    },
    get_pointer: () => [300, 300],
    stage: { width: 1920, height: 1080 },
};

// 导入被测核心代码
const extModule = await import('../extension.js');
const RawClipboardExtension = extModule.default;
const RESTORE_NONCE = extModule.RESTORE_NONCE;
const { RadixRawTree, RadixNode, findLongestCommonPrefix, makeSliceBytes, formatTime } = extModule;

// ============================================================================
// 2. 测试工具类与框架
// ============================================================================

class MockSelectionSource {
    constructor(mimetypes, bytes) {
        this._mimetypes = mimetypes;
        this._bytes = bytes instanceof GLib.Bytes ? bytes : new GLib.Bytes(bytes);
    }

    get_mimetypes() {
        return this._mimetypes;
    }

    async read_async(_mime, _cancellable) {
        return Gio.MemoryInputStream.new_from_bytes(this._bytes);
    }
}

class TestReporter {
    constructor() {
        this.totalSuites = 0;
        this.totalCases = 0;
        this.passedCases = 0;
        this.failedCases = 0;
        this.suiteStats = [];
        this.failures = [];
        this.currentSuite = null;
        this.startTime = Date.now();
    }

    suite(name) {
        this.totalSuites++;
        this.currentSuite = { name, passed: 0, failed: 0, cases: 0 };
        this.suiteStats.push(this.currentSuite);
        print(`\n======================================================================`);
        print(`[测试套件 ${this.totalSuites}] ${name}`);
        print(`======================================================================`);
    }

    async run(name, fn) {
        this.totalCases++;
        this.currentSuite.cases++;
        const t0 = Date.now();
        try {
            await fn();
            const elapsed = Date.now() - t0;
            this.passedCases++;
            this.currentSuite.passed++;
            print(`  ✓ [PASS] ${name} (${elapsed}ms)`);
        } catch (err) {
            const elapsed = Date.now() - t0;
            this.failedCases++;
            this.currentSuite.failed++;
            this.failures.push({ suite: this.currentSuite.name, name, error: err });
            printerr(`  ✗ [FAIL] ${name} (${elapsed}ms)`);
            printerr(`    -> 错误: ${err.message}`);
            if (err.stack) printerr(`    -> 调用栈:\n${err.stack}`);
        }
    }

    summary() {
        const totalDuration = Date.now() - this.startTime;
        print(`\n======================================================================`);
        print(`       纯内存剪贴板 v21.0 全方位功能与边界深度自动化测试报告`);
        print(`======================================================================`);
        for (const s of this.suiteStats) {
            const status = s.failed === 0 ? '✓' : '✗';
            print(`  ${status} ${s.name}: ${s.passed}/${s.cases} 通过`);
        }
        print(`----------------------------------------------------------------------`);
        print(`  总计用例:   ${this.totalCases}`);
        print(`  成功通过:   ${this.passedCases} (${(this.passedCases / this.totalCases * 100).toFixed(1)}%)`);
        print(`  失败用例:   ${this.failedCases}`);
        print(`  测试耗时:   ${totalDuration}ms`);
        if (this.failedCases > 0) {
            print(`\n  [异常失败明细]:`);
            for (const f of this.failures) {
                print(`   - [${f.suite}] ${f.name}: ${f.error.message}`);
            }
        } else {
            print(`\n  🎉 所有功能、UI尺寸规范、交互热区与边界压力测试 100% 成功通过！`);
        }
        print(`======================================================================\n`);
        return this.failedCases === 0;
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || '断言失败');
    }
}

function assertThrows(fn, expectedErrorType, message) {
    let threw = false;
    let actualError = null;
    try {
        fn();
    } catch (e) {
        threw = true;
        actualError = e;
    }
    if (!threw) {
        throw new Error(`预期应抛出异常但未抛出: ${message}`);
    }
    if (expectedErrorType && !(actualError instanceof expectedErrorType)) {
        throw new Error(`异常类型不匹配: 预期 ${expectedErrorType.name}, 实际 ${actualError?.name} (${actualError?.message})`);
    }
}

function getExtItemCount(ext) {
    ext._openPopup();
    const count = ext._itemActors ? ext._itemActors.length : 0;
    ext._closePopup();
    return count;
}

function getExtItem(ext, index) {
    ext._openPopup();
    if (!ext._itemActors || !ext._itemActors[index]) {
        ext._closePopup();
        return null;
    }
    const itemBox = ext._itemActors[index];
    const iconActor = itemBox.get_children()[0];
    const contentBox = itemBox.get_children()[1];
    const previewLabel = contentBox.get_children()[0];
    const subLabel = contentBox.get_children()[1];
    const timeLabel = itemBox.get_children().find(c => c.style_class && c.style_class.includes('raw-clipboard-item-time'));
    const res = {
        title: previewLabel.text,
        subtitle: subLabel.text,
        time: timeLabel ? timeLabel.text : null,
        hasThumbIcon: !!(iconActor.gicon instanceof Gio.Icon),
        iconName: iconActor.icon_name || null,
    };
    ext._closePopup();
    return res;
}

const reporter = new TestReporter();

// ============================================================================
// SUITE 1: 弹窗尺寸与底部页码规则验证 (UI Dimensions & Pagination Specs)
// ============================================================================
reporter.suite('1. 弹窗尺寸与底部页码规则验证');

await reporter.run('1.1 条目数 T = 0 时：弹窗常驻固定为 8 条目尺寸 + 排序栏 (468px)，正确展示居中空提示标签，底部区域常驻展示', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 验证 _calculateDesiredDimensions 理论计算值 (常驻 8 项尺寸 + 顶部排序栏 + 底部区域: 28 + 398 + 14 + 28 = 468)
    const dims = ext._calculateDesiredDimensions(null);
    assert(dims.popupWidth === 420, `弹窗宽度应为 420px，实际: ${dims.popupWidth}`);
    assert(dims.popupHeight === 468, `空列表弹窗高度常驻固定为 468px (28 + 398 + 14 + 28)，实际: ${dims.popupHeight}`);
    assert(dims.sortBarHeight === 28, `顶部排序栏高度必须为 28px，实际: ${dims.sortBarHeight}`);
    assert(dims.contentHeight === 398, `空列表内容高度必须为 398px，实际: ${dims.contentHeight}`);
    assert(dims.pageBarHeight === 28, `底部区域高度必须常驻为 28px，实际: ${dims.pageBarHeight}`);

    // 打开真实弹窗验证实际 UI Actor
    ext._openPopup();
    assert(ext._popup.width === 420, `_popup.width 实际: ${ext._popup.width}`);
    assert(ext._popup.height === 468, `_popup.height 实际: ${ext._popup.height}`);
    assert(ext._sortBar.height === 28, `_sortBar.height 实际: ${ext._sortBar.height}`);
    assert(ext._listContainer.height === 398, `_listContainer.height 实际: ${ext._listContainer.height}`);
    assert(ext._pageBar.visible === true, `_pageBar 必须常驻处于可见状态 (visible === true)`);
    assert(ext._undoBtn.reactive === false, `初始无待撤销项时撤销按钮禁用`);

    // 验证空占位标签
    const children = ext._listContainer.get_children();
    assert(children.some(c => c.text === '剪贴板历史为空'), `空列表应包含占位提示组件`);

    ext._closePopup();
    ext.disable();
});

await reporter.run('1.2 条目数 1 <= T <= 8 时：弹窗高度恒定为 8 条目尺寸 + 顶部栏 + 底部区域 (468px)，完全常驻不发生任何伸缩', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 逐级压入条目并验证 T = 1 到 8 时弹窗高度均恒定为 468px
    for (let t = 1; t <= 8; t++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`Item-Step-${t}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

        const dims = ext._calculateDesiredDimensions(null);
        assert(dims.contentHeight === 398, `T=${t} 内容高度恒定为 398px，实际: ${dims.contentHeight}`);
        assert(dims.popupHeight === 468, `T=${t} 弹窗高度恒定为 468px，实际: ${dims.popupHeight}`);
        assert(dims.pageBarHeight === 28, `T=${t} 底部区域高度恒定为 28px，实际: ${dims.pageBarHeight}`);

        ext._openPopup();
        assert(ext._popup.height === 468, `T=${t} 打开弹窗高度必须严格为 468px，实际: ${ext._popup.height}`);
        assert(ext._listContainer.height === 398, `T=${t} 列表容器高度必须严格为 398px，实际: ${ext._listContainer.height}`);
        assert(ext._pageBar.visible === true, `T=${t} 底部共享区域必须可见`);
        assert(ext._undoBtn !== null, `T=${t} 左下角撤销按钮必须存在`);
        assert(ext._pageBadge.visible === false, `T=${t} <= 8 单页状态下页码应隐藏`);
        assert(ext._itemActors.length === t, `T=${t} 当前页条目渲染数必须为 ${t}`);
        ext._closePopup();
    }

    ext.disable();
});

await reporter.run('1.3 条目数 T > 8 时：弹窗高度严格锁定为 8 条目尺寸 + 顶部栏 + 底部区域 = 468px，底部页码条居中显示', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 测试多个 T > 8 边界值: 9 (临界跨页), 10, 16 (整2页), 17 (跨3页), 24 (整3页), 30 (满队列)
    const testCounts = [9, 10, 16, 17, 24, 30];
    let currentInjected = 0;

    for (const targetCount of testCounts) {
        while (currentInjected < targetCount) {
            currentInjected++;
            const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`LockTest-Item-${currentInjected}`));
            await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
        }

        const dims = ext._calculateDesiredDimensions(null);
        assert(dims.contentHeight === 398, `T=${targetCount} 内容区必须严格锁定为 8 项高度 398px (8*48+7*2)，实际: ${dims.contentHeight}`);
        assert(dims.pageBarHeight === 28, `T=${targetCount} 页码高度必须为 28px，实际: ${dims.pageBarHeight}`);
        assert(dims.popupHeight === 468, `T=${targetCount} 弹窗高度必须严格锁定为 468px，实际: ${dims.popupHeight}`);

        ext._openPopup();
        assert(ext._popup.height === 468, `T=${targetCount} 实际弹窗高度必须为 468px，实际: ${ext._popup.height}`);
        assert(ext._listContainer.height === 398, `T=${targetCount} 实际列表容器高必须为 398px，实际: ${ext._listContainer.height}`);
        assert(ext._pageBar.visible === true, `T=${targetCount} 底部页码条必须可见`);
        assert(ext._pageBar.height === 28, `T=${targetCount} 底部页码条高度必须为 28px`);

        // 验证页码指示器 (靠右排列，分母位置恒定，避免翻页时文字抖动)
        const expectedTotalPages = Math.ceil(targetCount / 8);
        assert(ext._pageBadge.text === `1 / ${expectedTotalPages}`, `T=${targetCount} 首页角标应为 '1 / ${expectedTotalPages}'，实际: ${ext._pageBadge.text}`);
        assert(ext._pageBadge.x_align === Clutter.ActorAlign.END, `页码指示器必须靠右排列 (ActorAlign.END)`);
        assert(ext._pageBadge.y_align === Clutter.ActorAlign.CENTER, `页码指示器必须垂直居中`);

        ext._closePopup();
    }

    ext.disable();
});

await reporter.run('1.4 最后一页不满 8 条时窗口尺寸保持稳定：末页有 1~7 项时，弹窗高度保持为 468px，页码固定在底部', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 构造不同末页不满 8 项的场景:
    // Case A: T = 9 (末页仅 1 项)
    // Case B: T = 11 (末页仅 3 项)
    // Case C: T = 15 (末页仅 7 项)
    // Case D: T = 25 (末页仅 1 项, 4页)
    const subCases = [
        { total: 9, lastPageItems: 1, lastPageIndex: 1, totalPages: 2 },
        { total: 11, lastPageItems: 3, lastPageIndex: 1, totalPages: 2 },
        { total: 15, lastPageItems: 7, lastPageIndex: 1, totalPages: 2 },
        { total: 25, lastPageItems: 1, lastPageIndex: 3, totalPages: 4 },
    ];

    for (const sc of subCases) {
        // 重置队列
        ext.disable();
        ext.enable();
        for (let i = 1; i <= sc.total; i++) {
            const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`NoShrink-${sc.total}-Item-${i}`));
            await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
        }

        ext._openPopup();
        // 初始在第 0 页: 高度 468px
        assert(ext._popup.height === 468, `初始第 0 页高度应为 468px`);

        // 切换至最后一页
        ext._setPage(sc.lastPageIndex);
        assert(ext._currentPage === sc.lastPageIndex, `成功跳转到最后一页索引 ${sc.lastPageIndex}`);
        assert(ext._itemActors.length === sc.lastPageItems, `末页实际渲染项数应为 ${sc.lastPageItems}，实际: ${ext._itemActors.length}`);

        // 验证：弹窗高度保持稳定
        assert(ext._popup.height === 468, `末页仅 ${sc.lastPageItems} 项时，弹窗高度维持 468px，实际: ${ext._popup.height}`);
        assert(ext._listContainer.height === 398, `列表容器高度必须维持 398px，实际: ${ext._listContainer.height}`);
        assert(ext._pageBar.height === 28, `页码条高度必须维持 28px，实际: ${ext._pageBar.height}`);
        assert(ext._pageBar.visible === true, `页码条必须可见`);
        assert(ext._pageBadge.text === `${sc.lastPageIndex + 1} / ${sc.totalPages}`, `末页页码文本应为 '${sc.lastPageIndex + 1} / ${sc.totalPages}'，实际: ${ext._pageBadge.text}`);
        assert(ext._pageBadge.x_align === Clutter.ActorAlign.END, `末页页码指示器必须靠右排列 (ActorAlign.END)`);

        ext._closePopup();
    }

    ext.disable();
});

await reporter.run('1.5 屏幕高度受限时的边界自适应测试 (monitor.height - 64 临界处理)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 10; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`SmallMonitor-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    // 模拟极小屏幕 (高度仅 400px，最大允许高度 400 - 64 = 336px < 468px)
    const smallMonitor = { x: 0, y: 0, width: 800, height: 400 };
    const dims = ext._calculateDesiredDimensions(smallMonitor);

    assert(dims.popupHeight === 336, `受限屏幕下弹窗高应安全限制在 336px，实际: ${dims.popupHeight}`);
    assert(dims.popupHeight <= smallMonitor.height - 64, `弹窗绝不超出屏幕可用高度`);
    assert(dims.contentHeight === 336 - 14 - 28 - 28, `内容区高度自适应收缩至 ${336 - 14 - 28 - 28}px，实际: ${dims.contentHeight}`);

    ext.disable();
});

// ============================================================================
// SUITE 2: 空数据流与零字节容错测试
// ============================================================================
reporter.suite('2. 空数据流与零字节容错测试');

await reporter.run('2.1 剪贴板输入 0 字节空流 (过滤 0 字节，不入库且不崩溃)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const emptySrc = new MockSelectionSource(['text/plain'], new Uint8Array(0));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, emptySrc);

    assert(getExtItemCount(ext) === 0, '0 字节空流不得入库，队列应为空');
    assert(ext._lastChecksum === '', '0 字节流不应更新 checksum 状态');
    ext.disable();
});

await reporter.run('2.2 selectionSource 提供空 MIME 列表或 null 安全拦截', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 空列表
    const emptyMimeSrc = new MockSelectionSource([], new Uint8Array([1, 2, 3]));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, emptyMimeSrc);
    assert(getExtItemCount(ext) === 0, '空 MIME 列表不得入库');

    // null 列表
    const nullMimeSrc = { get_mimetypes: () => null };
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, nullMimeSrc);
    assert(getExtItemCount(ext) === 0, 'null MIME 列表不得入库');

    ext.disable();
});

await reporter.run('2.3 selectionType 非 CLIPBOARD 或 null selectionSource 安全忽略', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const dummySrc = new MockSelectionSource(['text/plain'], new TextEncoder().encode('IgnoredPrimary'));
    // PRIMARY 鼠标中键选区不入库
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_PRIMARY, dummySrc);
    assert(getExtItemCount(ext) === 0, '非 SELECTION_CLIPBOARD 选择区不应入库');

    // null selectionSource
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
    assert(getExtItemCount(ext) === 0, 'null selectionSource 应安全忽略');

    ext.disable();
});

await reporter.run('2.4 全空白符与换行纯文本摘要安全降级 (防空白标题溢出与无字渲染)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const spaces = new TextEncoder().encode('   \t\r\n   ');
    const src = new MockSelectionSource(['text/plain;charset=utf-8'], spaces);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '纯空格流有字节数，应被记录');
    const item = getExtItem(ext, 0);
    assert(item.title === '(空文本)', `全空白字符应优雅降级为 (空文本)，实际: ${item.title}`);
    assert(item.subtitle.includes('9 B'), `副标题大小应为 9 B，实际: ${item.subtitle}`);

    ext.disable();
});

await reporter.run('2.5 空 URI 列表文件复制行为测试 (text/uri-list 仅含换行与注释)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const emptyList = new TextEncoder().encode('# Nautilus comment\ncopy\n\n');
    const src = new MockSelectionSource(['text/uri-list'], emptyList);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '应安全捕获');
    const item = getExtItem(ext, 0);
    assert(item.title === '文件列表', `无有效路径时应降级显示文件列表，实际: ${item.title}`);
    assert(item.subtitle.includes('0 项'), `项数应统计为 0 项，实际: ${item.subtitle}`);

    ext.disable();
});

await reporter.run('2.6 统一4KB预览与单循环按需探查机制测试 (最多10次循环，遇到非空文本即跳出)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 前 150 字节为空格，后续为有效正文 (第 1 次循环 4KB 即可覆盖并立即跳出)
    const leading150Spaces = ' '.repeat(150) + 'Recovered Valid Text';
    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(leading150Spaces));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    let item = getExtItem(ext, 0);
    assert(item.title === 'Recovered Valid Text', `前150字节为空格时应直接正确提取正文，实际: ${item.title}`);

    // 2. 前 6000 字节为空白 (超过第 1 次 4KB 边界)，第 2 次循环 (累计 8KB) 成功提取正文
    const leading6000Spaces = ' '.repeat(6000) + 'Progressive 6000 Content';
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(leading6000Spaces));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    item = getExtItem(ext, 0);
    assert(item.title === 'Progressive 6000 Content', `前6000字节空白应通过第2次循环成功提取，实际: ${item.title}`);

    // 3. 前 20000 字节为空白，第 5 次循环后成功提取正文
    const leading20000Spaces = ' '.repeat(20000) + 'Deep Content 20k';
    const src3 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(leading20000Spaces));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src3);
    item = getExtItem(ext, 0);
    assert(item.title === 'Deep Content 20k', `前20000字节空白应循环提取，实际: ${item.title}`);

    // 4. 超过 10 次上限（>40960 字节，例如 50000 字节）全空白字符，安全收敛为 (空文本)
    const tooManySpaces = ' '.repeat(50000);
    const src4 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(tooManySpaces));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src4);
    item = getExtItem(ext, 0);
    assert(item.title === '(空文本)', `超过10次循环后全空白字符应优雅降级为 (空文本)，实际: ${item.title}`);

    ext.disable();
});

// ============================================================================
// SUITE 3: 超大容量载荷测试
// ============================================================================
reporter.suite('3. 超大容量边界与容量限制测试 (可配置单条上限，最高 1024MB/1GB)');

await reporter.run('3.1 设定 20MB 上限时，恰好 20MB (20,971,520 字节) 临界边界安全准入测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._settings.set_int('max-size-mb', 20);

    const EXACT_20MB = 20 * 1024 * 1024;
    const buf = new Uint8Array(EXACT_20MB);
    buf[0] = 0x41;
    buf[EXACT_20MB - 1] = 0x5a;

    const src = new MockSelectionSource(['application/octet-stream'], buf);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '恰好 20MB 属于合法上限，必须准入');
    const item = getExtItem(ext, 0);
    assert((item.subtitle || item.title).includes('20.0 MB'), `容量格式化应准确显示 20.0 MB，实际: ${item.subtitle || item.title}`);
    assert(ext._lastChecksum !== '', '应计算有效校验和');

    ext.disable();
});

await reporter.run('3.2 设定 20MB 上限时，20MB + 1 字节 (20,971,521 字节) 越界临界精准安全拦截', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._settings.set_int('max-size-mb', 20);

    const OVERSIZED = 20 * 1024 * 1024 + 1;
    const buf = new Uint8Array(OVERSIZED);
    const src = new MockSelectionSource(['application/octet-stream'], buf);

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 0, '20MB+1 字节必须被安全拦截，严禁入库');
    assert(ext._lastChecksum === '', '拦截条目不应改变状态');

    ext.disable();
});

await reporter.run('3.3 默认 50MB 上限时，100MB (104,857,600 字节) 巨型流前置分块熔断拦截测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._settings.set_int('max-size-mb', 50);

    const STREAM_100MB = 100 * 1024 * 1024;
    const buf = new Uint8Array(STREAM_100MB);
    const src = new MockSelectionSource(['application/x-giant-payload'], buf);

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 0, '100MB 巨型流必须被前置熔断拦截');

    ext.disable();
});

await reporter.run('3.4 可配置 1024MB (1GB) 最大上限设置支持测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._settings.set_int('max-size-mb', 1024);
    assert(ext._settings.get_int('max-size-mb') === 1024, '支持设置至 1024 MB (1GB)');
    ext.disable();
});

await reporter.run('3.5 容量字符串单位边界阶梯测试 (B, KB, MB 格式化精准度)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const cases = [
        { size: 500, expected: '500 B' },
        { size: 1024, expected: '1024 B' },
        { size: 2048, expected: '2.0 KB' },
        { size: 1048576, expected: '1024.0 KB' },
        { size: 2097152, expected: '2.0 MB' },
    ];

    for (const c of cases) {
        const buf = new Uint8Array(c.size);
        const src = new MockSelectionSource([`application/x-size-${c.size}`], buf);
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
        const item = getExtItem(ext, 0);
        assert((item.subtitle || item.title).includes(c.expected), `尺寸 ${c.size} 格式化预期含 ${c.expected}，实际: ${item.subtitle || item.title}`);
    }

    ext.disable();
});

await reporter.run('3.6 动态修改单项容量限制 (max-size-mb) 时自动清理历史中所有超出新限制的条目', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 初始允许单条 30MB
    ext._settings.set_int('max-size-mb', 30);

    // 写入条目 1: 15MB
    const buf15MB = new Uint8Array(15 * 1024 * 1024);
    buf15MB[0] = 1;
    const src1 = new MockSelectionSource(['application/octet-stream'], buf15MB);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);

    // 写入条目 2: 8MB
    const buf8MB = new Uint8Array(8 * 1024 * 1024);
    buf8MB[0] = 2;
    const src2 = new MockSelectionSource(['application/octet-stream'], buf8MB);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);

    assert(getExtItemCount(ext) === 2, '两项均正常入库');

    // 动态调小单项容量限制至 10MB (15MB 超过 10MB 必须被自动移除，8MB 保留)
    ext._settings.set_int('max-size-mb', 10);

    assert(getExtItemCount(ext) === 1, '修改限制后超限的 15MB 条目被自动移除');
    assert(ext._getEntry(0).size === 8 * 1024 * 1024, '保留符合新限制的 8MB 条目');

    // 恢复默认
    ext._settings.set_int('max-size-mb', 50);
    ext.disable();
});

// ============================================================================
// SUITE 4: 畸形与损坏数据测试
// ============================================================================
reporter.suite('4. 畸形或损坏数据容错测试 (乱码数据、残缺头、编码异常)');

await reporter.run('4.1 伪装为 image/png 但内容为全乱码坏字节 (缩略图解析失败优雅降级)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const src = new MockSelectionSource(['image/png'], garbage);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '损坏数据仍作为原始字节保留');
    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '缩略图解析失败应降级为 null');
    assert(item.iconName === 'image-x-generic-symbolic', '应降级显示通用图片图标');
    assert(item.subtitle === 'image/png', '副标题应保留 MIME 声明');

    ext.disable();
});

await reporter.run('4.2 残缺 PNG 魔数头部 (仅 8 字节 \\x89PNG 无任何 Chunk)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const truncatedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const src = new MockSelectionSource(['image/png'], truncatedPng);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '残缺 PNG 不得生成错误缩略图');
    assert(item.title === '图片 (8 B)', `标题应显示 图片 (8 B)，实际: ${item.title}`);

    ext.disable();
});

await reporter.run('4.3 残缺 JPEG SOI 头部 (仅 \\xFF\\xD8\\xFF 3 字节)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const truncatedJpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    const src = new MockSelectionSource(['image/jpeg'], truncatedJpeg);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '残缺 JPEG 应优雅降级');
    assert(item.title === '图片 (3 B)', `实际: ${item.title}`);

    ext.disable();
});

await reporter.run('4.4 伪装为 image/svg+xml 但内容为损坏 XML 标签与二进制乱码', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const corruptSvg = new TextEncoder().encode('<svg><unclosed tag <xml?!!\x00\xff');
    const src = new MockSelectionSource(['image/svg+xml'], corruptSvg);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '损坏 SVG 应降级');

    ext.disable();
});

await reporter.run('4.5 非法非 UTF-8 字节流输入 text/plain (防解码崩溃与异常捕获)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const illegalUtf8 = new Uint8Array([0xff, 0xfe, 0xc0, 0xaf, 0xe0, 0x80, 0x80]);
    const src = new MockSelectionSource(['text/plain;charset=utf-8'], illegalUtf8);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '非法 UTF-8 序列仍应被安全接收');

    ext.disable();
});

await reporter.run('4.6 畸形 URI 序列解析容错 (decodeURIComponent 触发 URIError 降级处理)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const attackUris = 'copy\nfile:///home/user/%E0%\nfile:///home/user/%ZZ%/test.txt\n';
    const src = new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(attackUris));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '畸形 URI 序列应平稳容错降级，不发生崩溃');
    const item = getExtItem(ext, 0);
    assert(item.title === '%E0%, test.txt', `畸形 URI 应容错保留原文本并正常显示文件名，实际: ${item.title}`);
    assert(item.subtitle.includes('2 项'), '副标题应统计条目数');
    assert(item.iconName === 'text-x-generic-symbolic', '图标应维持为文件类型');

    ext.disable();
});

// ============================================================================
// SUITE 5: 多类型缩略图生成测试
// ============================================================================
reporter.suite('5. 多种真实图片流缩略图生成测试 (PNG, JPEG, WebP, SVG, BMP)');

await reporter.run('5.1 真实 PNG 格式图片流缩略图与内存绑定', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const pb = new GdkPixbuf.Pixbuf({
        colorspace: GdkPixbuf.Colorspace.RGB,
        has_alpha: true,
        bits_per_sample: 8,
        width: 160,
        height: 120,
    });
    pb.fill(0x336699ff);
    const [, pngBuf] = pb.save_to_bufferv('png', [], []);

    const src = new MockSelectionSource(['image/png'], pngBuf);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === true, 'PNG 应生成真实有效 Gio.Icon 缩略图');
    ext.disable();
});

await reporter.run('5.2 真实 JPEG 格式图片流缩略图与内存绑定', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const pb = new GdkPixbuf.Pixbuf({
        colorspace: GdkPixbuf.Colorspace.RGB,
        has_alpha: false,
        bits_per_sample: 8,
        width: 150,
        height: 100,
    });
    pb.fill(0x228844ff);
    const [, jpegBuf] = pb.save_to_bufferv('jpeg', [], []);

    const src = new MockSelectionSource(['image/jpeg'], jpegBuf);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === true, 'JPEG 应生成真实缩略图');
    ext.disable();
});

await reporter.run('5.3 真实 WebP 格式图片流缩略图与内存绑定', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const pb = new GdkPixbuf.Pixbuf({
        colorspace: GdkPixbuf.Colorspace.RGB,
        has_alpha: true,
        bits_per_sample: 8,
        width: 100,
        height: 100,
    });
    pb.fill(0xee6622ff);
    const [, webpBuf] = pb.save_to_bufferv('webp', [], []);

    const src = new MockSelectionSource(['image/webp'], webpBuf);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === true, 'WebP 应生成真实缩略图');
    ext.disable();
});

await reporter.run('5.4 真实 BMP 格式图片流缩略图与内存绑定', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const pb = new GdkPixbuf.Pixbuf({
        colorspace: GdkPixbuf.Colorspace.RGB,
        has_alpha: true,
        bits_per_sample: 8,
        width: 64,
        height: 64,
    });
    pb.fill(0x992288ff);
    const [, bmpBuf] = pb.save_to_bufferv('bmp', [], []);

    const src = new MockSelectionSource(['image/bmp'], bmpBuf);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === true, 'BMP 应生成真实缩略图');
    ext.disable();
});

await reporter.run('5.5 真实 SVG 格式矢量图片处理 (仅存原始数据，不解析缩略图以避免过量消耗)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const svgXml = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#00e5ff"/></svg>';
    const src = new MockSelectionSource(['image/svg+xml'], new TextEncoder().encode(svgXml));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, 'SVG 不解析缩略图，避免额外的 XML 解析与缩略图开销');
    ext.disable();
});

await reporter.run('5.6 缩略图内存极小化校验 (生成的 PNG 缓冲 <= 1KB 纯内存)', async () => {
    const memIn = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
    ])));
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_at_scale(memIn, 64, 64, true, null);
    const [ok, thumbBuf] = pixbuf.save_to_bufferv('png', [], []);
    assert(ok, '缩略图保存成功');
    assert(thumbBuf.length < 1024, `缩略图仅耗 ${thumbBuf.length} 字节内存`);
});

await reporter.run('5.7 超出 4K 分辨率上限位图缩略图熔断测试 (max-thumbnail-dimension 4096 护栏)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 建立 4500x100 大图 (超过 4096 4K 边界)
    const bigPb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 4500, 100);
    bigPb.fill(0x334455ff);
    const [, bigBuf] = bigPb.save_to_bufferv('png', [], []);

    const src = new MockSelectionSource(['image/png'], bigBuf);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '超过 4096 4K 分辨率的大图不解析缩略图');
    ext.disable();
});

await reporter.run('5.8 图像解码炸弹拦截测试 (残缺或畸变高分辨率像素炸弹，解码校验失败安全降级)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 构造仅 69 字节但 IHDR 声明 3000x3000 像素的高分辨率残缺炸弹
    const bomb3000Png = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
        0x00, 0x00, 0x00, 0x0d, // IHDR length 13
        0x49, 0x48, 0x44, 0x52, // 'IHDR'
        0x00, 0x00, 0x0b, 0xb8, // width = 3000
        0x00, 0x00, 0x0b, 0xb8, // height = 3000
        0x08, 0x06, 0x00, 0x00, 0x00, // 8-bit RGBA
        0x71, 0x15, 0xf5, 0x79, // IHDR CRC32
        0x00, 0x00, 0x00, 0x0c, // IDAT length 12
        0x49, 0x48, 0x44, 0x52, // 'IDAT'
        0x78, 0x9c, 0x63, 0x60, 0xa0, 0x3d, 0x00, 0x00, 0x00, 0x64, 0x00, 0x01,
        0x86, 0x64, 0x3c, 0x35, // IDAT CRC32
        0x00, 0x00, 0x00, 0x00, // IEND length 0
        0x49, 0x45, 0x4e, 0x44, // 'IEND'
        0xae, 0x42, 0x60, 0x82  // IEND CRC32
    ]);

    const src = new MockSelectionSource(['image/png'], bomb3000Png);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '解码炸弹严禁生成缩略图，熔断拦截保护系统');
    assert(item.iconName === 'image-x-generic-symbolic', '降级为默认图片图标');
    assert(getExtItemCount(ext) === 1, '原始剪贴板数据正常入库不受损');
    ext.disable();
});

await reporter.run('5.9 图像解码炸弹拦截测试 (虚假微小尺寸声明灌入过量流式数据，超过最大合理内存上限安全熔断)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 建立 1x1 真实 PNG，但尾部拼接 1.5MB 冗余流式垃圾数据
    // 动态通道与位深计算出的合理内存上限 + 1MB 容差，灌入超过 1MB 时立刻熔断并不生成预览
    const pb1x1 = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 1, 1);
    pb1x1.fill(0xff0000ff);
    const [, validPng] = pb1x1.save_to_bufferv('png', [], []);

    const excessPayload = new Uint8Array(validPng.length + Math.floor(1.5 * 1024 * 1024));
    excessPayload.set(validPng, 0);
    excessPayload.fill(0x55, validPng.length);

    const src = new MockSelectionSource(['image/png'], excessPayload);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '超过最大合理内存上限的数据流被终止熔断');
    assert(getExtItemCount(ext) === 1, '原始超长数据完整入库');
    ext.disable();
});

await reporter.run('5.10 3通道无Alpha图片动态元数据识别与过量数据流安全熔断', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 建立 1x1 真实 3 通道 (RGB, 无 Alpha) JPEG，并拼接 1.5MB 垃圾数据
    const pb3ch = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 1, 1);
    pb3ch.fill(0xff8800ff);
    const [, validJpeg] = pb3ch.save_to_bufferv('jpeg', [], []);

    const excessPayload = new Uint8Array(validJpeg.length + Math.floor(1.5 * 1024 * 1024));
    excessPayload.set(validJpeg, 0);
    excessPayload.fill(0xaa, validJpeg.length);

    const src = new MockSelectionSource(['image/jpeg'], excessPayload);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '3通道图片动态计算内存上限，超量流式数据被正确熔断');
    assert(getExtItemCount(ext) === 1, '原始超长数据完整入库');
    ext.disable();
});

// ============================================================================
// SUITE 6: 文件复制与剪切动作拦截
// ============================================================================
reporter.suite('6. 复制文件行为测试 (多路径折叠、特殊字符、URL解码、零物理读取)');

await reporter.run('6.1 单文件与多文件折叠展示逻辑 (1个、2个、5个文件)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1 个文件
    const f1 = 'copy\nfile:///home/user/document.pdf\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(f1)));
    let item = getExtItem(ext, 0);
    assert(item.title === 'document.pdf', `实际: ${item.title}`);
    assert(item.subtitle.includes('1 项'), `实际: ${item.subtitle}`);

    // 2 个文件
    const f2 = 'copy\nfile:///home/user/first.png\nfile:///home/user/second.jpg\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(f2)));
    item = getExtItem(ext, 0);
    assert(item.title === 'first.png, second.jpg', `实际: ${item.title}`);
    assert(item.subtitle.includes('2 项'), `实际: ${item.subtitle}`);

    // 5 个文件折叠
    const f5 = 'copy\nfile:///path/1.txt\nfile:///path/2.txt\nfile:///path/3.txt\nfile:///path/4.txt\nfile:///path/5.txt\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(f5)));
    item = getExtItem(ext, 0);
    assert(item.title === '1.txt, 2.txt 等 5 个文件', `多文件折叠实际: ${item.title}`);
    assert(item.subtitle.includes('5 项'), `实际: ${item.subtitle}`);

    ext.disable();
});

await reporter.run('6.2 剪切文件精准拦截与复制文件安全入库 (GNOME cut & KDE cutselection 严禁入库)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. GNOME Nautilus 剪切文件 (首行为 cut)
    const cutText = '# GNOME Nautilus Drag\ncut\nfile:///home/user/target_moved.txt\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['x-special/gnome-copied-files'], new TextEncoder().encode(cutText)));
    assert(getExtItemCount(ext) === 0, 'GNOME 剪切文件严禁进入历史队列');

    // 2. KDE Dolphin 剪切文件 (包含 application/x-kde-cutselection)
    const kdeCutText = 'file:///home/user/kde_moved.txt\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list', 'application/x-kde-cutselection'], new TextEncoder().encode(kdeCutText)));
    assert(getExtItemCount(ext) === 0, 'KDE 剪切文件严禁进入历史队列');

    // 3. 正常复制文件 (首行为 copy 或纯 uri-list) 应正常进入历史队列
    const copyText = '# GNOME Nautilus Drag\ncopy\nfile:///home/user/target_copied.txt\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['x-special/gnome-copied-files'], new TextEncoder().encode(copyText)));
    assert(getExtItemCount(ext) === 1, '正常复制文件应正常进入历史队列');
    const item = getExtItem(ext, 0);
    assert(item.title === 'target_copied.txt', `copy 与注释应被剥离，实际: ${item.title}`);
    assert(item.subtitle.includes('1 项'), `实际: ${item.subtitle}`);

    ext.disable();
});

await reporter.run('6.3 特殊字符、中文编码与带尾部斜杠目录 URL 解码', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const complex = [
        'copy',
        'file:///home/vmuser/%E7%A3%A8%E7%A0%82%E7%8E%BB%E7%92%83%E8%AE%BE%E8%AE%A1%E7%A8%BF.sketch',
        'file:///home/vmuser/Project%20%28V2%29%20%26%20Draft%231.tar.gz',
        'file:///home/vmuser/target_directory/',
    ].join('\n');

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(complex)));

    const item = getExtItem(ext, 0);
    assert(item.title.includes('等 3 项'), `3 项应折叠并准确标识混选项，实际: ${item.title}`);
    assert(item.subtitle.includes('文件/目录 · 3 项'), `混选副标题应为文件/目录，实际: ${item.subtitle}`);
    assert(item.iconName === 'folder-symbolic', `混选图标应为 folder-symbolic，实际: ${item.iconName}`);

    ext.disable();
});

await reporter.run('6.4 复制文件路径行为测试 (不触发物理文件读取，复制虚拟路径无磁盘 I/O)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const nonExistentLarge = 'copy\nfile:///dev/huge_disk_array_10TB.raw\n';
    const rawBytes = new TextEncoder().encode(nonExistentLarge);

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], rawBytes));

    const item = getExtItem(ext, 0);
    assert(item.title === 'huge_disk_array_10TB.raw', `实际: ${item.title}`);
    assert(item.subtitle.includes('仅存路径，不读内容'), '必须显式标注仅存路径');
    assert(rawBytes.length < 60, `内存驻留仅 ${rawBytes.length} 字节`);

    ext.disable();
});

await reporter.run('6.5 敏感凭据/密码捕获测试 (密码管理器文本正常捕获入纯内存，不落盘)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const sensitiveCases = [
        ['x-kde-passwordManagerHint', 'text/plain'],
        ['application/x-vnd.passwordmanager-hint', 'text/plain'],
        ['application/x-keepassxc-hint', 'text/plain'],
        ['application/x-1password-hint', 'text/plain'],
        ['application/x-bitwarden-hint', 'text/plain'],
        ['text/x-moz-url-priv', 'text/plain'],
        ['custom/x-PasswordManager-Token', 'text/plain'],
    ];

    let i = 0;
    for (const mimes of sensitiveCases) {
        const pw = `super_secret_password_${i++}`;
        const src = new MockSelectionSource(mimes, new TextEncoder().encode(pw));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
        assert(getExtItemCount(ext) === 1, `含有密码管理器标识 [${mimes.join(', ')}] 的文本数据应正常捕获到内存中`);
        const item = getExtItem(ext, 0);
        assert(item.title === pw, '密码内容必须原样完整保留');
        ext._deleteEntry(0);
    }

    ext.disable();
});

await reporter.run('6.6 目录与文件精准区分测试 (单目录、多目录、单文件、多文件与真实磁盘目录嗅探)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 复制单目录 (尾部带 / 的显式目录)
    const singleDirUri = 'copy\nfile:///home/user/my_folder/\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(singleDirUri)));
    let item = getExtItem(ext, 0);
    assert(item.title === 'my_folder', `单目录名实际: ${item.title}`);
    assert(item.subtitle.includes('文件夹 · 1 项'), `单目录副标题实际: ${item.subtitle}`);
    assert(item.iconName === 'folder-symbolic', `单目录图标实际: ${item.iconName}`);

    // 2. 复制真实存在的本地磁盘目录 (不带尾部斜杠，由 GLib.file_test 嗅探为目录)
    const actualDirUri = 'copy\nfile:///home/vmuser/tmpfs/raw-clipboard\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(actualDirUri)));
    item = getExtItem(ext, 0);
    assert(item.title === 'raw-clipboard', `实际磁盘目录名实际: ${item.title}`);
    assert(item.subtitle.includes('文件夹 · 1 项'), `实际磁盘目录副标题实际: ${item.subtitle}`);
    assert(item.iconName === 'folder-symbolic', `实际磁盘目录图标实际: ${item.iconName}`);

    // 3. 复制多个纯目录
    const multiDirUri = 'copy\nfile:///home/user/dir1/\nfile:///home/user/dir2/\nfile:///home/user/dir3/\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(multiDirUri)));
    item = getExtItem(ext, 0);
    assert(item.title.includes('等 3 个文件夹'), `多目录标题实际: ${item.title}`);
    assert(item.subtitle.includes('文件夹 · 3 项'), `多目录副标题实际: ${item.subtitle}`);
    assert(item.iconName === 'folder-symbolic', `多目录图标实际: ${item.iconName}`);

    // 4. 复制普通文件 (text-x-generic-symbolic)
    const singleFileUri = 'copy\nfile:///home/user/regular_file.txt\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(singleFileUri)));
    item = getExtItem(ext, 0);
    assert(item.title === 'regular_file.txt', `单文件名实际: ${item.title}`);
    assert(item.subtitle.includes('文件 · 1 项'), `单文件副标题实际: ${item.subtitle}`);
    assert(item.iconName === 'text-x-generic-symbolic', `单文件图标必须为 text-x-generic-symbolic，实际: ${item.iconName}`);

    ext.disable();
});

// ============================================================================
// SUITE 7: 容量淘汰与回放提升
// ============================================================================
reporter.suite('7. 队列容量淘汰测试 (max-items 边界、FIFO 淘汰、LRU 优先级)');

await reporter.run('7.1 Max-Items Schema 边界锁定 (min=5) 与 FIFO 先入先出淘汰', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._settings.set_int('max-items', 5);

    for (let i = 1; i <= 8; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`QueueEntry-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    assert(getExtItemCount(ext) === 5, '队列长度严守 max-items=5 下限阈值');
    assert(getExtItem(ext, 0).title === 'QueueEntry-8', '头部为最新 Entry 8');
    assert(getExtItem(ext, 1).title === 'QueueEntry-7', '第2项为 Entry 7');
    assert(getExtItem(ext, 2).title === 'QueueEntry-6', '第3项为 Entry 6');
    assert(getExtItem(ext, 3).title === 'QueueEntry-5', '第4项为 Entry 5');
    assert(getExtItem(ext, 4).title === 'QueueEntry-4', '第5项为 Entry 4');

    ext._settings.set_int('max-items', 30);
    ext.disable();
});

await reporter.run('7.2 动态设置变更即刻裁剪超出条目 (_settings changed::max-items 缩容至 5 项)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._settings.set_int('max-items', 10);
    for (let i = 1; i <= 8; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`Dynamic-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    assert(getExtItemCount(ext) === 8, '初始应有 8 条');

    ext._settings.set_int('max-items', 5);
    assert(getExtItemCount(ext) === 5, '监听到设置变化后立即缩容至 5 项');
    assert(getExtItem(ext, 0).title === 'Dynamic-8', '保留最新项 Dynamic-8');
    assert(getExtItem(ext, 4).title === 'Dynamic-4', '尾项为 Dynamic-4，旧条目被弹出');

    ext._settings.set_int('max-items', 30);
    ext.disable();
});

await reporter.run('7.3 条目回放与 LRU 提升测试 (_restoreEntry 重置优先级)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`LRU-Target-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    assert(getExtItem(ext, 2).title === 'LRU-Target-1', '尾项为 LRU-Target-1');

    ext._openPopup();
    ext._setSelectedIndex(2);
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Return });

    assert(getExtItem(ext, 0).title === 'LRU-Target-1', '回放项成功跃迁至队列首位');
    assert(ext._lastChecksum !== '', '应预置对齐 _lastChecksum');

    const echoSrc = new MockSelectionSource(['text/plain'], new TextEncoder().encode('LRU-Target-1'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, echoSrc);
    assert(getExtItemCount(ext) === 3, '系统回环事件被自然去重拦截，队列条数不增加');

    // 验证自发回灌回环标识机制：
    // ① 未匹配标识的数据源：正常执行读取
    let fakeReadCalled = false;
    const fakeSource = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Forged-Data-1'));
    fakeSource[RESTORE_NONCE] = 'forged-uuid-99999';
    const origFakeRead = fakeSource.read_async.bind(fakeSource);
    fakeSource.read_async = (...args) => {
        fakeReadCalled = true;
        return origFakeRead(...args);
    };
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, fakeSource);
    assert(fakeReadCalled === true, '未命中标识时必须正常发起 read_async 读取');

    // ② 真实回灌时由 _restoreEntry 挂载的回环标识：精准识别并跳过读取
    globalThis._lastOwnedSource = null;
    ext._openPopup();
    ext._setSelectedIndex(0);
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Return });
    assert(globalThis._lastOwnedSource !== null, '_restoreEntry 必须成功生成原生数据源');
    assert(typeof globalThis._lastOwnedSource[RESTORE_NONCE] === 'string', '数据源对象上需挂载一次性回环标识');
    assert(globalThis._lastOwnedSource.get_mimetypes()[0] === 'text/plain', '回灌时保持源声明的 text/plain，不额外拼接 charset');

    let realReadCalled = false;
    const realSource = globalThis._lastOwnedSource;
    realSource.read_async = () => {
        realReadCalled = true;
        throw new Error('FAIL: 自发回灌源不应重复发起 read_async 读取！');
    };
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, realSource);
    assert(realReadCalled === false, '回环标识命中，成功跳过自发回灌的重复读取');

    // ③ 验证单次消费：标识匹配消费后即刻移除，后续事件正常处理
    let secondReadCalled = false;
    realSource.read_async = () => {
        secondReadCalled = true;
        throw new Error('INTERCEPT_SUCCESS: 确认进入常规读取分支');
    };
    try {
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, realSource);
    } catch (_e) {}
    assert(secondReadCalled === true, '回环标识消费后移除，后续信号正常走常规读取分支');

    ext.disable();
});

await reporter.run('7.4 相同内容去重测试 (连续相同输入不增加历史)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const data = new TextEncoder().encode('Identical Repeated Clip');
    const src1 = new MockSelectionSource(['text/plain'], data);
    const src2 = new MockSelectionSource(['text/plain'], data);

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    const check1 = ext._lastChecksum;
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);

    assert(getExtItemCount(ext) === 1, '相同内容必须去重');
    assert(ext._lastChecksum === check1, 'checksum 维持原值');

    ext.disable();
});

await reporter.run('7.5 disable 清空纯内存历史 (解除所有引用供 GC 回收)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`MemLeakTest-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    assert(getExtItemCount(ext) === 3, '已写入 3 项');

    ext.disable();
    ext.enable();
    assert(getExtItemCount(ext) === 0, '重新启用后队列应重置为空');
    ext.disable();
});

await reporter.run('7.6 全局总内存上限裁剪测试 (max-total-size-mb 内存超额 FIFO 淘汰)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._settings.set_int('max-size-mb', 30);
    ext._settings.set_int('max-total-size-mb', 50);

    const buf25MB = new Uint8Array(25 * 1024 * 1024);
    buf25MB[0] = 1;
    const src1 = new MockSelectionSource(['application/octet-stream'], buf25MB);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    assert(getExtItemCount(ext) === 1, '条目 1 写入成功');

    const buf20MB = new Uint8Array(20 * 1024 * 1024);
    buf20MB[0] = 2;
    const src2 = new MockSelectionSource(['application/octet-stream'], buf20MB);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    assert(getExtItemCount(ext) === 2, '合计 45MB，两项均被保留');

    const buf20MB_2 = new Uint8Array(20 * 1024 * 1024);
    buf20MB_2[0] = 3;
    const src3 = new MockSelectionSource(['application/octet-stream'], buf20MB_2);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src3);
    assert(getExtItemCount(ext) === 2, '超出全局总上限，自动淘汰最旧条目');

    ext._settings.set_int('max-size-mb', 50);
    ext._settings.set_int('max-total-size-mb', 1024);
    ext.disable();
});

await reporter.run('7.7 全局非连续重复复制 LRU 提升测试 (A->B->A 自动提升至队首，无冗余重复项)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const srcA1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Global-Target-A'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA1);

    const srcB = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Global-Target-B'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcB);

    assert(getExtItemCount(ext) === 2, '当前有 A 和 B 两项');
    assert(getExtItem(ext, 0).title === 'Global-Target-B', '队首为 B');
    assert(getExtItem(ext, 1).title === 'Global-Target-A', '第二项为 A');

    const srcA2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Global-Target-A'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA2);

    assert(getExtItemCount(ext) === 2, '全局去重生效：总数仍为 2，未产生重复 A');
    assert(getExtItem(ext, 0).title === 'Global-Target-A', 'A 被零拷贝自动提升至队首');
    assert(getExtItem(ext, 1).title === 'Global-Target-B', 'B 顺延至第二项');

    ext.disable();
});

await reporter.run('7.8 大于64KiB前缀相同但尾部不同/仅改动末尾字符的内容安全区分测试 (小指纹+Size+全量哈希双重精确判定)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 生成 70,000 字节的纯 'A' 字符串 (超出 64KiB = 65,536 字节)
    const base70KB = 'A'.repeat(70000);
    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(base70KB));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    assert(getExtItemCount(ext) === 1, '第 1 项 70KB 入库成功');

    // 2. 生成同样以 65,536 字节 'A' 开头，但尾部少了 10 个字符的字符串 (69,990 字节)
    // 验证：虽然前 64KiB 小指纹 100% 相同，但总大小 size 不同，必须安全准入，绝不误伤！
    const shorter69KB = 'A'.repeat(69990);
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(shorter69KB));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    assert(getExtItemCount(ext) === 2, '前 64KiB 相同但少选尾部字符的内容成功被识别为不同条目！');

    // 3. 生成总大小恰好同样为 70,000 字节，前 64KiB 也同样为 'A'，但在第 68,000 字节处改动 1 个字符为 'B'
    // 验证：虽然小指纹与总大小 size 均相同，但全量哈希不同，依然精准识别为不同条目！
    const modified70KB = 'A'.repeat(65536) + 'A'.repeat(2463) + 'B' + 'A'.repeat(2000);
    const src3 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(modified70KB));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src3);
    assert(getExtItemCount(ext) === 3, '大小与前64KiB均相同但尾部有改动的内容，通过全量哈希精准识别并入库！');

    ext.disable();
});

// ============================================================================
// SUITE 8: 条目快速删除与圆圈点击热区判定
// ============================================================================
reporter.suite('8. 条目快速删除与圆圈点击热区判定');

await reporter.run('8.1 快速连续单项删除与索引安全收敛', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 4; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`ItemToDel-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    assert(getExtItemCount(ext) === 4, '初始 4 项');

    ext._deleteEntry(0);
    assert(getExtItemCount(ext) === 3, '剩 3 项');

    ext._deleteEntry(2);
    assert(getExtItemCount(ext) === 2, '剩 2 项');

    ext._deleteEntry(0);
    ext._deleteEntry(0);
    assert(getExtItemCount(ext) === 0, '完全清空');

    ext._openPopup();
    assert(ext._selectedIndex === 0, '空列表时 _selectedIndex 重置为 0');
    assert(ext._listContainer.children[0].text === '剪贴板历史为空', '正确渲染空状态占位标签');
    ext._closePopup();

    ext.disable();
});

await reporter.run('8.2 越界数值删除索引容错测试 (-1, 100, 999 越界检查)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode('KeepAlive'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    ext._deleteEntry(-1);
    ext._deleteEntry(1);
    ext._deleteEntry(999);
    ext._deleteEntry(-999);

    assert(getExtItemCount(ext) === 1, '越界数值删除不应修改有效队列');
    ext.disable();
});

await reporter.run('8.3 非整数索引参数校验测试 (NaN / undefined / 字符串参数守卫)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Alpha'));
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Beta'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    assert(getExtItemCount(ext) === 2, '初始应有 2 项');

    // 严苛测试: 传入 NaN, undefined, '0', null, 1.5 等非法非整数索引
    ext._deleteEntry(NaN);
    ext._deleteEntry(undefined);
    ext._deleteEntry('0');
    ext._deleteEntry(null);
    ext._deleteEntry(1.5);

    assert(getExtItemCount(ext) === 2, '类型守卫生效：非整数索引安全忽略，条目数仍为 2');
    ext.disable();
});

await reporter.run('8.4 扁平化 48x48 正方形垃圾桶删除按钮与条目恢复判定测试 (点击删除按钮触发暂存删除，退出弹窗后统一执行删除)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 删除按钮直接点击删除测试
    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('DelBtnTest-1'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);

    ext._openPopup();
    const itemBox1 = ext._itemActors[0];
    const deleteBtn1 = itemBox1.get_children().find(c => c.style_class && c.style_class.includes('raw-clipboard-delete-btn'));
    assert(deleteBtn1 !== undefined, '必须成功构建 48x48 扁平化正方形删除按钮');
    assert(deleteBtn1.width === 48 && deleteBtn1.height === 48, '删除按钮可点击区域必须为 48x48 正方形');
    const deleteIcon1 = deleteBtn1.child || (deleteBtn1.get_children && deleteBtn1.get_children()[0]);
    assert(deleteIcon1 && deleteIcon1.icon_name === 'user-trash-symbolic', '图标必须为 user-trash-symbolic');

    let restored = false;
    let closed = false;
    const realRestore = ext._restoreEntry.bind(ext);
    const realClose = ext._closePopup.bind(ext);
    ext._restoreEntry = (e) => { restored = true; realRestore(e); };
    ext._closePopup = () => { closed = true; realClose(); };

    const makeMouseEvent = (source, cx = 0, cy = 0) => ({
        get_button: () => 1,
        get_source: () => source,
        get_coords: () => [cx, cy],
    });

    let res1 = deleteBtn1.emit('button-press-event', makeMouseEvent(deleteBtn1));
    assert(res1 === Clutter.EVENT_STOP, '删除按钮直接点击事件必须被消费 (EVENT_STOP)');
    assert(!restored, '删除按钮直接点击严禁误触发条目恢复');
    ext._closePopup();
    assert(getExtItemCount(ext) === 0, '退出弹窗后必须统一提交删除条目');

    // 2. 删除按钮释放与点击事件 (button-release-event 与 clicked 信号)
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('DelBtnTest-2'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    ext._openPopup();
    const itemBox2 = ext._itemActors[0];
    const deleteBtn2 = itemBox2.get_children().find(c => c.style_class && c.style_class.includes('raw-clipboard-delete-btn'));

    restored = false;
    closed = false;
    let resRel = deleteBtn2.emit('button-release-event', makeMouseEvent(deleteBtn2));
    assert(resRel === Clutter.EVENT_STOP, '删除按钮释放事件必须被消费 (EVENT_STOP)');
    assert(!restored && !closed, '删除按钮释放严禁误触发恢复');
    deleteBtn2.emit('clicked');
    ext._closePopup();
    assert(getExtItemCount(ext) === 0, '删除按钮 clicked 信号且退出弹窗后必须成功物理删除条目');

    // 3. 非左键点击条目正文必须忽略并传播 (EVENT_PROPAGATE，不触发恢复)
    const src3 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('DelBtnTest-3'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src3);
    ext._openPopup();
    const itemBox3 = ext._itemActors[0];

    restored = false;
    closed = false;
    const makeRightClickEvent = () => ({
        get_button: () => 3,
        get_source: () => null,
        get_coords: () => [100, 20],
    });
    let resRight = itemBox3.emit('button-press-event', makeRightClickEvent());
    // GObject signal emit with boolean accumulator returns false when propagated (EVENT_PROPAGATE = false)
    assert(Boolean(resRight) === false, '右键点击条目正文必须未被消费 (false/EVENT_PROPAGATE)');
    assert(!restored && !closed, '右键点击严禁误恢复');
    ext._closePopup();

    // 4. 真实 GNOME Shell 行为：左键点击条目正文区域 -> 精准触发恢复并关闭弹窗
    ext._openPopup();
    const itemBox4 = ext._itemActors[0];
    restored = false;
    closed = false;
    let res4 = itemBox4.emit('button-press-event', makeMouseEvent(itemBox4, 100, 20));
    assert(res4 === Clutter.EVENT_STOP, '普通条目左键点击被消费');
    assert(restored === true, '点击条目正文必须成功恢复');
    assert(closed === true, '恢复后必须关闭弹窗');

    ext.disable();
});

await reporter.run('8.5 跨页删除末页唯一条目时页码收敛测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 写入 9 条数据 (第 0 页 8 条，第 1 页 1 条)
    for (let i = 1; i <= 9; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`Converge-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    assert(ext._popup.height === 468, '初始 9 条高 468px');

    // 跳转到第 1 页 (仅 1 条，即全局第 8 项)
    ext._setPage(1);
    assert(ext._currentPage === 1, '当前在第 1 页');

    // 删除该项 (全局索引 8)
    ext._deleteEntry(8);

    // 验证：总项数变 8，当前页自动向前收敛至第 0 页，选中项处于安全边界内 [0, 7]，高度保持 468px (含底部区域)
    assert(ext._currentPage === 0, `末页唯一项删除后，当前页应自动收敛至第 0 页，实际: ${ext._currentPage}`);
    assert(ext._selectedIndex >= 0 && ext._selectedIndex < 8, `选中索引必须在当前页安全范围内 [0, 7]，实际: ${ext._selectedIndex}`);
    assert(ext._popup.height === 468, `条目数回落至 8 时，弹窗高度保持为 468px (含底部共享区域)，实际: ${ext._popup.height}`);
    assert(ext._pageBar.visible === true, `回落至 8 项时底部区域保持可见`);
    assert(ext._pageBadge.visible === false, `回落至 8 项时单页页码应隐藏`);
    assert(ext._undoBtn.reactive === true, `存在待撤销删除项时撤销按钮应处于激活状态`);

    ext._closePopup();
    ext.disable();
});

await reporter.run('8.6 选中尾项删除后 _selectedIndex 自动向内收敛', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`TailDel-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    ext._setSelectedIndex(2);
    assert(ext._selectedIndex === 2, '选中尾项 2');

    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Delete });
    assert(getExtItemCount(ext) === 2, '删除后剩 2 项');
    assert(ext._selectedIndex === 1, '选中索引自动收敛至新尾项 1');

    ext._closePopup();
    ext.disable();
});

await reporter.run('8.7 _restoreEntry 传入 null 或无效对象容错测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._restoreEntry(null);
    ext._restoreEntry(undefined);
    ext._restoreEntry({});
    ext._restoreEntry({ bytes: null });

    assert(getExtItemCount(ext) === 0, '无效 entry 回放应安全忽略');
    ext.disable();
});

await reporter.run('8.8 清空或删除条目后相同内容再次复制入库测试 (避免状态滞留导致无法入库)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 复制 A 入库
    const srcA1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Alpha'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA1);
    assert(getExtItemCount(ext) === 1, '条目 A 入库成功');

    // 连续复制 A 应被去重
    const srcA2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Alpha'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA2);
    assert(getExtItemCount(ext) === 1, '连续复制 A 正常去重');

    // 2. 删除唯一的条目 A（队列清空）
    ext._deleteEntry(0);
    assert(getExtItemCount(ext) === 0, '删除后队列为空');

    // 3. 再次复制刚刚被删除的条目 A，必须能正常再次入库，绝不能被旧哈希拦截！
    const srcA3 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Alpha'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA3);
    assert(getExtItemCount(ext) === 1, '清空历史后复制相同内容必须成功入库');
    assert(getExtItem(ext, 0).title === 'Item-Alpha', '新条目内容正确');

    // 4. 复制条目 B
    const srcB1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Beta'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcB1);
    assert(getExtItemCount(ext) === 2, '条目 B 入库成功');

    // 5. 删除队首条目 B，队列剩余 A
    ext._deleteEntry(0);
    assert(getExtItemCount(ext) === 1, '删除队首后剩 1 项');
    assert(getExtItem(ext, 0).title === 'Item-Alpha', '队首变为 A');

    // 6. 再次复制刚刚删除的条目 B，必须能正常入库
    const srcB2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Beta'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcB2);
    assert(getExtItemCount(ext) === 2, '删除队首后再次复制相同内容必须成功入库');
    assert(getExtItem(ext, 0).title === 'Item-Beta', '最新队首为 B');

    ext.disable();
});

await reporter.run('8.9 删除 Undo 撤销功能测试 (弹窗内删除多项后逐项 Undo 恢复，物理队列零丢失)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`UndoTest-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    assert(ext._itemActors.length === 3, '初始弹窗渲染 3 项');
    assert(ext._undoBtn.reactive === false, '初始无待删除项时撤销按钮禁用');

    // 1. 删除索引 1 (UndoTest-2)
    ext._deleteEntry(1);
    assert(ext._itemActors.length === 2, '暂存删除后弹窗内展示 2 项');
    assert(ext._undoBtn.reactive === true, '存在待删除项时撤销按钮激活');

    // 2. 再次删除索引 0 (UndoTest-3)
    ext._deleteEntry(0);
    assert(ext._itemActors.length === 1, '暂存删除后弹窗内展示 1 项');

    // 3. 点击 Undo 撤销最近一次删除 (恢复 UndoTest-3)
    const undoRes1 = ext._undoLastDelete();
    assert(undoRes1 === true, '第一次撤销成功');
    assert(ext._itemActors.length === 2, '撤销后弹窗内恢复为 2 项');
    assert(ext._undoBtn.reactive === true, '仍有一项待删除，撤销按钮继续激活');

    // 4. 再次点击 Undo 撤销 (恢复 UndoTest-2)
    const undoRes2 = ext._undoLastDelete();
    assert(undoRes2 === true, '第二次撤销成功');
    assert(ext._itemActors.length === 3, '全部撤销后弹窗内恢复为 3 项');
    assert(ext._undoBtn.reactive === false, '待删除项清空，撤销按钮恢复禁用');

    // 5. 退出弹窗并验证物理持久化队列完全无丢失
    ext._closePopup();
    assert(getExtItemCount(ext) === 3, '退出弹窗后队列完整保留 3 项');
    assert(getExtItem(ext, 0).title === 'UndoTest-3', '队首正确');
    assert(getExtItem(ext, 1).title === 'UndoTest-2', '第二项正确');
    assert(getExtItem(ext, 2).title === 'UndoTest-1', '第三项正确');

    ext.disable();
});

await reporter.run('8.10 退出弹窗统一提交物理删除测试 (弹窗内删 2 项撤 1 项，退出后精准物理删除剩余 1 项)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`DeferredDel-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    // 删除索引 2 (DeferredDel-1) 和 索引 1 (DeferredDel-2)
    ext._deleteEntry(2);
    ext._deleteEntry(1);
    assert(ext._itemActors.length === 1, '弹窗内剩 1 项 (DeferredDel-3)');

    // 撤销最近一次删除 (恢复 DeferredDel-2)
    ext._undoLastDelete();
    assert(ext._itemActors.length === 2, '撤销后弹窗内为 2 项 (DeferredDel-3, DeferredDel-2)');

    // 退出弹窗：此时应统一执行物理删除，仅物理删除 DeferredDel-1
    ext._closePopup();

    assert(getExtItemCount(ext) === 2, '物理历史精确保留 2 项');
    assert(getExtItem(ext, 0).title === 'DeferredDel-3', '队首为 DeferredDel-3');
    assert(getExtItem(ext, 1).title === 'DeferredDel-2', '第二项为 DeferredDel-2');

    ext.disable();
});

await reporter.run('8.11 快捷键 Ctrl+Z 触发撤销与按钮状态同步测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode('ShortcutUndoItem'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    ext._openPopup();
    assert(ext._itemActors.length === 1, '初始 1 项');
    assert(ext._undoBtn.reactive === false, '初始撤销按钮未激活');

    // 删除该项
    ext._deleteEntry(0);
    assert(ext._itemActors.length === 0, '条目暂存删除后弹窗变空');
    assert(ext._undoBtn.reactive === true, '撤销按钮激活');
    assert(ext._pageBar.visible === true, '删光后底部区域依然常驻供用户点击撤销');

    // 模拟按键 Ctrl+Z
    const ctrlZEvent = {
        get_key_symbol: () => Clutter.KEY_z,
        get_state: () => Clutter.ModifierType.CONTROL_MASK,
    };
    const keyRes = ext._onKeyPress(ctrlZEvent);
    assert(keyRes === Clutter.EVENT_STOP, 'Ctrl+Z 快捷键被消费');
    assert(ext._itemActors.length === 1, 'Ctrl+Z 成功恢复被删除条目');
    assert(ext._undoBtn.reactive === false, '撤销后撤销按钮禁用');

    ext._closePopup();
    assert(getExtItemCount(ext) === 1, '退出后条目安全保留在历史中');
    ext.disable();
});

await reporter.run('8.12 弹窗尺寸恒定测试 (小于8条时无论删除、撤销多少，弹窗尺寸与底部撤销按钮位置始终完全保持恒定)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`FixedDim-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    const initialPopupHeight = ext._popup.height;
    const initialContentHeight = ext._listContainer.height;
    const initialPageBarHeight = ext._pageBar.height;
    assert(initialPopupHeight === 468, `常驻弹窗高度必须严格等于 468px，实际: ${initialPopupHeight}`);
    assert(initialContentHeight === 398, `常驻内容容器高度必须为 398px，实际: ${initialContentHeight}`);
    assert(initialPageBarHeight === 28, `底部区域高度必须为 28px`);

    // 1. 删除 1 条
    ext._deleteEntry(2);
    assert(ext._popup.height === initialPopupHeight, `删除第 1 项后弹窗高度严禁改变，仍为 ${initialPopupHeight}px，实际: ${ext._popup.height}`);
    assert(ext._listContainer.height === initialContentHeight, `列表容器高度严禁改变，仍为 ${initialContentHeight}px`);
    assert(ext._pageBar.height === initialPageBarHeight, `底部区域高度严禁改变，仍为 ${initialPageBarHeight}px`);

    // 2. 删除第 2 条
    ext._deleteEntry(1);
    assert(ext._popup.height === initialPopupHeight, `删除第 2 项后弹窗高度严禁改变，仍为 ${initialPopupHeight}px`);
    assert(ext._listContainer.height === initialContentHeight, `列表容器高度严禁改变，仍为 ${initialContentHeight}px`);

    // 3. 删除第 3 条 (全部删光，展示空状态)
    ext._deleteEntry(0);
    assert(ext._popup.height === initialPopupHeight, `删光后弹窗高度依然严禁改变，仍为 ${initialPopupHeight}px`);
    assert(ext._listContainer.height === initialContentHeight, `列表容器高度依然严禁改变，仍为 ${initialContentHeight}px`);
    assert(ext._pageBar.visible === true, `删光后底部区域保持可见供撤销`);

    // 4. 连续撤销 3 次
    ext._undoLastDelete();
    assert(ext._popup.height === initialPopupHeight, `撤销 1 次后弹窗高度保持恒定`);
    ext._undoLastDelete();
    assert(ext._popup.height === initialPopupHeight, `撤销 2 次后弹窗高度保持恒定`);
    ext._undoLastDelete();
    assert(ext._popup.height === initialPopupHeight, `撤销 3 次后弹窗高度保持恒定`);
    assert(ext._listContainer.height === initialContentHeight, `全部撤销后列表容器高度保持恒定`);

    ext._closePopup();
    ext.disable();
});

await reporter.run('8.13 弹窗开启期间外部剪贴板新增条目测试 (常驻8项尺寸平滑容纳，零溢出零形变)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`LiveItem-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    assert(ext._popup.height === 468, '初始打开为常驻 468px');
    assert(ext._itemActors.length === 3, '初始渲染 3 项');

    // 在弹窗保持开启状态下，系统发生新的复制行为
    const newSrc = new MockSelectionSource(['text/plain'], new TextEncoder().encode('LiveItem-New-4'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, newSrc);

    // 触发渲染队列
    ext._renderPage();

    assert(ext._popup.height === 468, '新增条目后弹窗高度完全恒定为 468px，无尺寸跳动');
    assert(ext._listContainer.height === 398, '列表容器高度恒定为 398px');
    assert(ext._itemActors.length === 4, '当前页成功平滑展示 4 项，队首为最新条目');
    assert(ext._itemActors[0].get_children().some(c => c.text === 'LiveItem-New-4' || c.get_children && c.get_children().some(cc => cc.text === 'LiveItem-New-4')), '最新条目成功排入队首');

    ext._closePopup();
    ext.disable();
});

await reporter.run('8.14 弹窗开启期间外部复制新条目时的软删除与撤销自适应测试 (标记删除期间外部新增条目，撤销精准按物理顺延还原)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 初始入库 3 项: Alpha, Beta, Gamma (Gamma 为最新)
    for (const title of ['Item-Alpha', 'Item-Beta', 'Item-Gamma']) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(title));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    assert(ext._itemActors.length === 3, '初始弹窗展示 3 项');
    const getVisibleTitles = () => ext._itemActors.map(a => a.get_children()[1].get_children()[0].text);
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Gamma', 'Item-Beta', 'Item-Alpha']), '初始列表顺序正确');

    // 2. 在弹窗内软删除索引 1 (Item-Beta)
    ext._deleteEntry(1);
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Gamma', 'Item-Alpha']), '软删除后列表跳过 Beta');
    assert(ext._undoBtn.reactive === true, '存在软删除条目，撤销按钮激活');

    // 3. 在弹窗保持开启期间，外部发生复制行为 (新条目 Delta)
    const srcDelta = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Delta'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcDelta);
    ext._renderPage();

    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Delta', 'Item-Gamma', 'Item-Alpha']), '外部新增 Delta 后列表实时更新，排入队首并跳过软删除的 Beta');

    // 4. 执行撤销: Beta 必须精准还原到 Delta 和 Gamma 之后、Alpha 之前的位置 (原相对顺延次序)
    const undoRes = ext._undoLastDelete();
    assert(undoRes === true, '撤销成功');
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Delta', 'Item-Gamma', 'Item-Beta', 'Item-Alpha']), '撤销后 Beta 精准顺延还原，零错位零错项');
    assert(ext._selectedIndex === 2, `撤销后选中项精准定位至还原项索引 2，实际: ${ext._selectedIndex}`);
    assert(ext._undoBtn.reactive === false, '全部撤销后撤销按钮禁用');

    // 5. 再次进行多项交替软删除与外部复制
    // 当前列表: [Delta, Gamma, Beta, Alpha]
    // 软删除 Delta (索引 0) 和 Alpha (索引 3)
    ext._deleteEntry(0); // 删 Delta，列表剩 [Gamma, Beta, Alpha]
    ext._deleteEntry(2); // 删 Alpha，列表剩 [Gamma, Beta]
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Gamma', 'Item-Beta']), '软删除 Delta 和 Alpha');

    // 外部复制 Epsilon
    const srcEpsilon = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Epsilon'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcEpsilon);
    ext._renderPage();
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Epsilon', 'Item-Gamma', 'Item-Beta']), '外部新增 Epsilon');

    // 撤销 1: 恢复 Alpha (最后删除的)
    ext._undoLastDelete();
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Epsilon', 'Item-Gamma', 'Item-Beta', 'Item-Alpha']), '撤销恢复 Alpha');
    assert(ext._selectedIndex === 3, '焦点定位至 Alpha');

    // 撤销 2: 恢复 Delta
    ext._undoLastDelete();
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Item-Epsilon', 'Item-Delta', 'Item-Gamma', 'Item-Beta', 'Item-Alpha']), '撤销恢复 Delta');
    assert(ext._selectedIndex === 1, '焦点定位至 Delta');

    // 退出弹窗，验证底层物理存储零丢失
    ext._closePopup();
    assert(getExtItemCount(ext) === 5, '退出后物理历史完整保留 5 项');

    ext.disable();
});

await reporter.run('8.15 弹窗开启期间软删除条目被重新复制或未撤销提交物理删除测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 初始入库 2 项: Red, Green
    for (const title of ['Color-Red', 'Color-Green']) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(title));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    const getVisibleTitles = () => ext._itemActors.map(a => a.get_children()[1].get_children()[0].text);
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Color-Green', 'Color-Red']), '初始红绿');

    // 软删除 Red (索引 1)
    ext._deleteEntry(1);
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Color-Green']), '列表仅剩 Green');
    assert(ext._undoBtn.reactive === true, '撤销按钮激活');

    // 外部再次复制 Red (复活逻辑: 解除软删除并提升至队首)
    const srcRedAgain = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Color-Red'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcRedAgain);
    ext._renderPage();

    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Color-Red', 'Color-Green']), '重新复制已软删除的条目成功复活并提升至队首');
    assert(ext._undoBtn.reactive === false, '复活后软删除标记清除，撤销按钮恢复禁用');

    // 软删除 Green (索引 1)，且不执行撤销直接关闭弹窗
    ext._deleteEntry(1);
    assert(JSON.stringify(getVisibleTitles()) === JSON.stringify(['Color-Red']), '软删除 Green');

    // 关闭弹窗触发物理提交
    ext._closePopup();

    assert(getExtItemCount(ext) === 1, '退出弹窗后统一提交物理删除，Green 被彻底清除');
    assert(getExtItem(ext, 0).title === 'Color-Red', '物理保留项为 Red');

    ext.disable();
});

// ============================================================================
// SUITE 9: 键盘与滚轮离散翻页交互
// ============================================================================
reporter.suite('9. 键盘与滚轮离散翻页交互 (Up/Down/Left/Right/PageUp/PageDown/Enter/Delete)');

await reporter.run('9.1 Up / Down 基础与跨页导航测试 (页内步进、跨页切换、首尾循环)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 写入 10 项 (第 0 页 8 项，第 1 页 2 项)
    for (let i = 1; i <= 10; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`Nav-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    assert(ext._currentPage === 0 && ext._selectedIndex === 0, '初始在第 0 页第 0 项');

    // Down 步进
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Down });
    assert(ext._selectedIndex === 1, 'Down 键选中项移至 1');

    // 移至第 0 页尾项 (7)
    ext._setSelectedIndex(7);
    // 在第 0 页尾项按 Down -> 自动跨页进入第 1 页首项 (0)
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Down });
    assert(ext._currentPage === 1, '跨页进入第 1 页');
    assert(ext._selectedIndex === 0, '选中第 1 页首项 0');

    // 移至第 1 页尾项 (1)
    ext._setSelectedIndex(1);
    // 在末页尾项按 Down -> 首尾循环回到第 0 页首项 (0)
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Down });
    assert(ext._currentPage === 0, '末页尾项 Down 循环回第 0 页');
    assert(ext._selectedIndex === 0, '选中第 0 页首项 0');

    // 在第 0 页首项按 Up -> 首尾循环进入末页尾项
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Up });
    assert(ext._currentPage === 1, '首页首项 Up 循环至末页');
    assert(ext._selectedIndex === 1, '选中末页尾项 1');

    // 在第 1 页首项按 Up -> 跨页翻至上一页尾项 (7)
    ext._setSelectedIndex(0);
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Up });
    assert(ext._currentPage === 0, '第 1 页首项 Up 翻回第 0 页');
    assert(ext._selectedIndex === 7, '选中第 0 页尾项 7');

    ext._closePopup();
    ext.disable();
});

await reporter.run('9.2 Left / Right 离散翻页导航测试 (上一页/下一页与循环翻页)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 20; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`LRNav-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    // 20 项共 3 页 (0: 8项, 1: 8项, 2: 4项)

    ext._openPopup();
    assert(ext._currentPage === 0, '初始在第 0 页');

    // Right 翻到下一页
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Right });
    assert(ext._currentPage === 1, 'Right 翻到第 1 页');

    // Right 再翻到下一页
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Right });
    assert(ext._currentPage === 2, 'Right 翻到第 2 页 (末页)');

    // 在末页按 Right -> 循环翻页回到第 0 页 (首页)
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Right });
    assert(ext._currentPage === 0, '末页按 Right 循环翻页回到第 0 页');

    // 首页按 Left -> 循环翻页到达第 2 页 (末页)
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Left });
    assert(ext._currentPage === 2, '首页按 Left 循环翻页到达末页');

    // Left 翻回上一页
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Left });
    assert(ext._currentPage === 1, 'Left 翻回第 1 页');

    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Left });
    assert(ext._currentPage === 0, 'Left 翻回第 0 页');

    ext._closePopup();
    ext.disable();
});

await reporter.run('9.3 PageUp / PageDown 快捷翻页测试 (上一页/下一页与循环翻页)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 16; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`PageUpDown-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    ext._setSelectedIndex(3);
    assert(ext._currentPage === 0 && ext._selectedIndex === 3, '初始在第 0 页选中 3');

    // PageDown 翻下一页
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Page_Down });
    assert(ext._currentPage === 1, 'PageDown 翻至第 1 页');
    assert(ext._selectedIndex === 3, '保持选中索引 3');

    // 末页按 PageDown -> 循环翻至第 0 页
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Page_Down });
    assert(ext._currentPage === 0, '末页 PageDown 循环翻至第 0 页');

    // 首页按 PageUp -> 循环翻至末页 (第 1 页)
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Page_Up });
    assert(ext._currentPage === 1, '首页 PageUp 循环翻至末页');

    // PageUp 翻回上一页
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Page_Up });
    assert(ext._currentPage === 0, 'PageUp 翻至第 0 页');
    assert(ext._selectedIndex === 3, '保持选中索引 3');

    ext._closePopup();
    ext.disable();
});

await reporter.run('9.4 Enter / KP_Enter / Space 恢复条目并关闭弹窗测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-For-Enter'));
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-For-Space'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);

    let restoredItem = null;
    let popupClosed = false;
    ext._restoreEntry = (e) => { restoredItem = e; };
    ext._closePopup = () => { popupClosed = true; };

    ext._openPopup();
    ext._setSelectedIndex(0);

    // 1. Enter
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Return });
    assert(restoredItem !== null, 'Enter 键成功触发条目恢复');
    assert(popupClosed === true, 'Enter 键成功关闭弹窗');

    // 2. Space
    restoredItem = null;
    popupClosed = false;
    ext._openPopup();
    ext._setSelectedIndex(1);
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_space });
    assert(restoredItem !== null, 'Space 键成功触发条目恢复');
    assert(popupClosed === true, 'Space 键成功关闭弹窗');

    // 3. 小键盘 Enter (KP_Enter)
    restoredItem = null;
    popupClosed = false;
    ext._openPopup();
    ext._setSelectedIndex(0);
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_KP_Enter });
    assert(restoredItem !== null, 'KP_Enter 键成功触发条目恢复');
    assert(popupClosed === true, 'KP_Enter 键成功关闭弹窗');

    ext.disable();
});

await reporter.run('9.5 Delete / BackSpace 键盘快速删除当前条目测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`KeyDel-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    assert(getExtItemCount(ext) === 3, '初始 3 项');

    ext._openPopup();
    ext._setSelectedIndex(1);

    // Delete 键
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Delete });
    assert(getExtItemCount(ext) === 2, 'Delete 键成功删除条目');

    // BackSpace 键
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_BackSpace });
    assert(getExtItemCount(ext) === 1, 'BackSpace 键成功删除条目');

    ext._closePopup();
    ext.disable();
});

await reporter.run('9.6 Esc 键安全关闭弹窗测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    let popupClosed = false;
    ext._closePopup = () => { popupClosed = true; };

    ext._openPopup();
    const res = ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Escape });
    assert(res === Clutter.EVENT_STOP, 'Esc 必须消费事件');
    assert(popupClosed === true, 'Esc 键必须调用 _closePopup');

    ext.disable();
});

await reporter.run('9.7 鼠标离散滚轮向上/向下翻页与平滑滚轮阈值判定测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 16; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`ScrollItem-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    assert(ext._currentPage === 0, '初始在第 0 页');

    const makeScrollEvent = (dir, dx = 0, dy = 0) => ({
        get_scroll_direction: () => dir,
        get_scroll_delta: () => [dx, dy],
    });

    // 1. 离散 DOWN 滚轮
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.DOWN));
    assert(ext._currentPage === 1, '离散向下滚动成功翻至第 1 页');

    // 等待 200ms 跨过防抖阈值
    GLib.usleep(200000);

    // 2. 离散 UP 滚轮
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.UP));
    assert(ext._currentPage === 0, '离散向上滚动成功翻至第 0 页');

    // 等待 200ms
    GLib.usleep(200000);

    // 3. 平滑滚动向下 (dy = 0.5 > 0.1)
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.SMOOTH, 0, 0.5));
    assert(ext._currentPage === 1, '平滑滚动 dy=0.5 翻至第 1 页');

    // 等待 200ms
    GLib.usleep(200000);

    // 4. 平滑微小位移 (dy = 0.05 <= 0.1) -> 必须被过滤
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.SMOOTH, 0, 0.05));
    assert(ext._currentPage === 1, '微小位移 dy=0.05 安全忽略，不触发误翻页');

    // 等待 200ms
    GLib.usleep(200000);

    // 5. 末页向下滚动循环翻页回到第 0 页
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.DOWN));
    assert(ext._currentPage === 0, '末页向下滚动循环翻页回到第 0 页');

    // 等待 200ms
    GLib.usleep(200000);

    // 6. 首页向上滚动循环翻页到达末页第 1 页
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.UP));
    assert(ext._currentPage === 1, '首页向上滚动循环翻页到达末页第 1 页');

    ext._closePopup();
    ext.disable();
});

await reporter.run('9.8 滚轮事件极速防抖保护测试 (快速连续滚动防失控翻页)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 24; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`DebounceItem-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    assert(ext._currentPage === 0, '初始在第 0 页');

    const makeScrollEvent = (dir) => ({
        get_scroll_direction: () => dir,
        get_scroll_delta: () => [0, 0],
    });

    // 首次向下滚动
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.DOWN));
    assert(ext._currentPage === 1, '首次向下滚动翻至第 1 页');

    // 立即连续触发多次滚动 (无时间间隔，瞬时连击)
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.DOWN));
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.DOWN));
    ext._popup.emit('scroll-event', makeScrollEvent(Clutter.ScrollDirection.DOWN));

    assert(ext._currentPage === 1, '防抖保护生效：瞬间多次滚动被有效吸收，当前页仍为 1');

    ext._closePopup();
    ext.disable();
});

await reporter.run('9.9 空队列状态下的全键盘操作安全防崩溃测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._openPopup();

    const keys = [
        Clutter.KEY_Up,
        Clutter.KEY_Down,
        Clutter.KEY_Left,
        Clutter.KEY_Right,
        Clutter.KEY_Page_Up,
        Clutter.KEY_Page_Down,
        Clutter.KEY_Return,
        Clutter.KEY_KP_Enter,
        Clutter.KEY_space,
        Clutter.KEY_Delete,
        Clutter.KEY_BackSpace,
    ];

    for (const k of keys) {
        const res = ext._onKeyPress({ get_key_symbol: () => k });
        assert(res === Clutter.EVENT_STOP, `空队列按键 ${k} 必须被安全消费且无异常`);
    }

    ext._closePopup();
    ext.disable();
});

await reporter.run('9.10 快捷键关闭弹窗测试 (弹窗打开状态下按 <Super>v 或 togglePopup 正确关闭弹窗)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode('ToggleCloseItem'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    // 1. 测试通过 _onKeyPress 快捷键事件关闭弹窗
    const origShortcuts = ext._settings.get_strv('toggle-shortcut');
    ext._settings.set_strv('toggle-shortcut', ['<Super>v']);
    try {
        ext._openPopup();
        assert(ext._container !== null, '弹窗成功打开');

        const shortcutEvent = {
            get_key_symbol: () => Clutter.KEY_v,
            get_state: () => Clutter.ModifierType.SUPER_MASK,
        };
        const keyRes = ext._onKeyPress(shortcutEvent);
        assert(keyRes === Clutter.EVENT_STOP, '快捷键事件被消费');
        assert(ext._container === null, '按快捷键 <Super>v 成功关闭弹窗');

        // 2. 测试通过 _togglePopup 在弹窗打开时调用关闭
        ext._openPopup();
        assert(ext._container !== null, '弹窗再次打开');
        ext._togglePopup();
        assert(ext._container === null, '_togglePopup 成功关闭已打开的弹窗');
    } finally {
        ext._settings.set_strv('toggle-shortcut', origShortcuts);
    }

    ext.disable();
});

// ============================================================================
// SUITE 10: 对象封装与日志开关验证
// ============================================================================
reporter.suite('10. 冻结对象与封装性测试');

await reporter.run('10.1 Object.isFrozen 冻结对象与严格模式属性只读保护', async () => {
    const rawData = new Uint8Array([0x12, 0x34, 0x56]);
    const testBytes = new GLib.Bytes(rawData);

    const entry = Object.freeze({
        id: 'frozen_entry_1',
        type: 'raw',
        mime: 'application/octet-stream',
        bytes: testBytes,
        checksum: 'sha256_sample',
        preview: 'raw',
        subtitle: 'raw sub',
        icon: 'application-x-generic-symbolic',
        time: Date.now(),
    });

    assert(Object.isFrozen(entry), '条目对象必须被 Object.freeze 冻结');

    assertThrows(() => {
        'use strict';
        entry.mime = 'application/hacked';
    }, TypeError, '修改条目 mime 必须抛出 TypeError');
    assert(entry.mime === 'application/octet-stream', 'mime 属性未被修改');

    assertThrows(() => {
        'use strict';
        entry.bytes = null;
    }, TypeError, '置空 bytes 引用必须抛出 TypeError');
    assert(entry.bytes === testBytes, 'bytes 引用完整无损');

    assertThrows(() => {
        'use strict';
        entry.injectedMalicious = true;
    }, TypeError, '添加新属性必须抛出 TypeError');

    assertThrows(() => {
        'use strict';
        delete entry.id;
    }, TypeError, '删除属性必须抛出 TypeError');
    assert(entry.id === 'frozen_entry_1', 'id 属性未被删除');
});

await reporter.run('10.2 原型与属性定义保护测试 (defineProperty / setPrototypeOf)', async () => {
    const entry = Object.freeze({
        id: 'anti_reflection_1',
        mime: 'text/plain',
    });

    assertThrows(() => {
        Object.defineProperty(entry, 'mime', { value: 'tampered', writable: true });
    }, TypeError, 'Object.defineProperty 应当被拒绝并抛出 TypeError');

    assertThrows(() => {
        Object.setPrototypeOf(entry, { compromised: true });
    }, TypeError, 'Object.setPrototypeOf 试图修改原型应当被拒绝并抛出 TypeError');

    assert(Object.getPrototypeOf(entry) === Object.prototype, '原型保持为 Object.prototype');
});

await reporter.run('10.3 GLib.Bytes 底层原生堆内存不可变性测试', async () => {
    const rawData = new Uint8Array([10, 20, 30, 40]);
    const gBytes = new GLib.Bytes(rawData);

    const arr = gBytes.toArray();
    arr[0] = 99;
    arr[1] = 88;

    const fresh = gBytes.toArray();
    assert(fresh[0] === 10, 'GBytes 底层字节未受外部修改影响');
    assert(fresh[1] === 20, 'GBytes 底层字节未受外部修改影响');
});

await reporter.run('10.4 私有字段 #history 封装性验证', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    assert(ext['#history'] === undefined, '属性索引访问不到私有字段');
    assert(!Reflect.has(ext, '#history'), 'Reflect.has 无法探测私有字段');
    assert(!Object.getOwnPropertyNames(ext).includes('#history'), 'getOwnPropertyNames 不可见');
    assert(Object.getOwnPropertySymbols(ext).length === 0, '未通过 Symbol 暴露');

    ext.disable();
});

await reporter.run('10.5 跨条目独立性隔离 (多条目冻结不互相干扰)', async () => {
    const b1 = new GLib.Bytes(new Uint8Array([1]));
    const b2 = new GLib.Bytes(new Uint8Array([2]));

    const e1 = Object.freeze({ id: '1', bytes: b1 });
    const e2 = Object.freeze({ id: '2', bytes: b2 });

    assert(e1 !== e2, '不同条目对象引用独立');
    assert(e1.bytes !== e2.bytes, '底层字节引用独立');
});

await reporter.run('10.6 条目对象冻结属性只读验证 (Object.freeze 保护)', async () => {
    const b = new GLib.Bytes(new Uint8Array([1, 2, 3]));
    const item = Object.freeze({
        id: 'test_item',
        mime: 'text/plain',
        type: 'text',
        bytes: b,
    });

    assert(Object.isFrozen(item), '条目对象必须被冻结');
    assertThrows(() => {
        'use strict';
        item.mime = 'image/png';
    }, TypeError, '条目对象属性不可修改');
});

await reporter.run('10.7 日志开关功能验证 (enable-logging 关闭时静默，开启时按需输出)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._settings.set_boolean('enable-logging', false);
    assert(ext._isLoggingEnabled() === false, '默认状态下日志应处于关闭状态');

    ext._log('test log');
    ext._warn('test warn');
    ext._error('test error');

    ext._settings.set_boolean('enable-logging', true);
    assert(ext._isLoggingEnabled() === true, '开启后日志状态为 true');
    ext._log('test log enabled');
    ext._warn('test warn enabled');

    ext._settings.set_boolean('enable-logging', false);
    assert(ext._isLoggingEnabled() === false, '恢复后日志处于关闭状态');
    ext.disable();
});

await reporter.run('10.8 disable() 实例级 Cancellable 取消在途读取与历史隔离测试 (读完后严禁写回 #history)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 模拟一个挂起的异步读取源
    class SlowSelectionSource {
        get_mimetypes() { return ['text/plain']; }
        async read_async(_mime, cancellable) {
            return new Promise((resolve, reject) => {
                const cancelId = cancellable ? cancellable.connect(() => {
                    reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                }) : 0;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    if (cancelId > 0 && cancellable) cancellable.disconnect(cancelId);
                    resolve(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode('Late Data'))));
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    const slowSrc = new SlowSelectionSource();
    const readPromise = ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, slowSrc);

    // 立即执行 disable()，模拟锁屏或扩展禁用
    ext.disable();

    await readPromise;
    assert(getExtItemCount(ext) === 0, 'disable() 取消在途读取后，历史队列必须严格保持为空，严禁写回 #history');
});

// ============================================================================
// SUITE 11: 慢源读取三重守卫测试 (0字节停滞超时、总体硬超时、新所有者易手抢占丢弃)
// ============================================================================
reporter.suite('11. 慢源读取三重守卫测试 (0字节停滞超时、总体硬超时、易手抢占丢弃)');

await reporter.run('11.1 守卫 1: 0 字节停滞超时 (连续无新数据到达中断并丢弃半截数据)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._inactivityTimeoutMs = 50; // 50ms 停滞看门狗

    class StalledSource {
        get_mimetypes() { return ['text/plain']; }
        async read_async(_mime, _cancellable) {
            return {
                read_bytes_async(_count, _priority, cancellable) {
                    return new Promise((_resolve, reject) => {
                        if (cancellable) {
                            cancellable.connect(() => {
                                reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                            });
                        }
                        // 故意不返回任何数据，模拟管道 0 字节停滞卡死
                    });
                }
            };
        }
    }

    const stalledSrc = new StalledSource();
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, stalledSrc);
    assert(getExtItemCount(ext) === 0, '0 字节停滞超时后，未完成的数据不写入历史队列');
    ext.disable();
});

await reporter.run('11.2 守卫 2: 总体硬超时上限 (多次慢读取累积总耗时超限中断并丢弃)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._inactivityTimeoutMs = 1000; // 停滞看门狗不触发
    ext._overallTimeoutMs = 60;     // 总体硬超时 60ms

    class DripSlowSource {
        constructor() {
            this._chunkIdx = 0;
        }
        get_mimetypes() { return ['text/plain']; }
        async read_async(_mime, _cancellable) {
            const self = this;
            return {
                read_bytes_async(_count, _priority, cancellable) {
                    return new Promise((resolve, reject) => {
                        if (cancellable) {
                            cancellable.connect(() => {
                                reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                            });
                        }
                        // 每次 25ms 吐一小块，计划吐 10 次 (需 250ms，远超 60ms 硬上限)
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
                            if (cancellable && cancellable.is_cancelled()) {
                                return GLib.SOURCE_REMOVE;
                            }
                            self._chunkIdx++;
                            resolve(new GLib.Bytes(new TextEncoder().encode(`Chunk${self._chunkIdx}`)));
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                }
            };
        }
    }

    const dripSrc = new DripSlowSource();
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, dripSrc);
    assert(getExtItemCount(ext) === 0, '总体硬超时触发后，未完成的数据不写入历史队列');
    ext.disable();
});

await reporter.run('11.3 守卫 3: 慢源读取中发生新的 owner-changed 抢占中断并丢弃旧源', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    class SlowSourceA {
        get_mimetypes() { return ['text/plain']; }
        async read_async(_mime, cancellable) {
            return new Promise((resolve, reject) => {
                const cancelId = cancellable ? cancellable.connect(() => {
                    reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                }) : 0;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (cancelId > 0 && cancellable) cancellable.disconnect(cancelId);
                    resolve(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode('Slow Old Data A'))));
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    const slowA = new SlowSourceA();
    const promiseA = ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, slowA);

    // 15ms 后，外部应用复制了新内容 Quick New Data B
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => { r(); return GLib.SOURCE_REMOVE; }));
    const quickB = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Quick New Data B'));
    const promiseB = ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, quickB);

    await Promise.all([promiseA, promiseB]);

    assert(getExtItemCount(ext) === 1, '旧慢源被抢占丢弃后，历史队列中只能有新源 1 项');
    const item = getExtItem(ext, 0);
    assert(item.title === 'Quick New Data B', '入库项必须是最新所有者 B 的数据，旧源 A 严禁覆盖');
    ext.disable();
});

await reporter.run('11.4 守卫 3: 慢源读取中剪贴板清空 (selectionSource 为 null) 抢占中断并丢弃', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    class SlowSourceA {
        get_mimetypes() { return ['text/plain']; }
        async read_async(_mime, cancellable) {
            return new Promise((resolve, reject) => {
                const cancelId = cancellable ? cancellable.connect(() => {
                    reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                }) : 0;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (cancelId > 0 && cancellable) cancellable.disconnect(cancelId);
                    resolve(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode('Slow Old Data A'))));
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    const slowA = new SlowSourceA();
    const promiseA = ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, slowA);

    // 15ms 后剪贴板被清空 (selectionSource 为 null)
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => { r(); return GLib.SOURCE_REMOVE; }));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);

    await promiseA;
    assert(getExtItemCount(ext) === 0, '剪贴板清空时，在途慢源立即中止丢弃，历史队列为空');
    ext.disable();
});

await reporter.run('11.5 守卫 3: 慢源读取中触发回灌 (_restoreEntry) 抢占中断并丢弃旧源', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 先正常入库一条初始历史
    const initSrc = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Initial Item'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, initSrc);
    assert(getExtItemCount(ext) === 1, '初始项入库成功');

    class SlowSourceA {
        get_mimetypes() { return ['text/plain']; }
        async read_async(_mime, cancellable) {
            return new Promise((resolve, reject) => {
                const cancelId = cancellable ? cancellable.connect(() => {
                    reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                }) : 0;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (cancelId > 0 && cancellable) cancellable.disconnect(cancelId);
                    resolve(Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode('Slow Stale Data A'))));
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    const slowA = new SlowSourceA();
    const promiseA = ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, slowA);

    // 15ms 后，外部触发新的 owner-changed（模拟 restoreEntry 或系统所有权变更）
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => { r(); return GLib.SOURCE_REMOVE; }));
    
    // 构造带 RESTORE_NONCE 的回灌源触发 owner-changed
    const restoreSource = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Restored Item'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, restoreSource);

    await promiseA;
    // 慢源 A 被抢占取消，新源 restoreSource 成功处理
    const item = getExtItem(ext, 0);
    assert(item.title === 'Restored Item', '慢源 A 被抢占并丢弃，新所有者数据生效');
    ext.disable();
});

await reporter.run('11.6 守卫设置 Schema 读写与动态超时生效测试 (inactivity-timeout-sec 与 overall-timeout-sec)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 先重置为系统默认值，避免外部环境 dconf 残留值干扰
    ext._settings.reset('inactivity-timeout-sec');
    ext._settings.reset('overall-timeout-sec');

    // 验证默认值
    assert(ext._settings.get_int('inactivity-timeout-sec') === 5, '默认 0 字节停滞超时为 5 秒');
    assert(ext._settings.get_int('overall-timeout-sec') === 15, '默认总体硬超时为 15 秒');

    // 修改并验证设置生效
    ext._settings.set_int('inactivity-timeout-sec', 10);
    assert(ext._settings.get_int('inactivity-timeout-sec') === 10, '修改停滞超时为 10 秒成功');

    ext._settings.set_int('overall-timeout-sec', 45);
    assert(ext._settings.get_int('overall-timeout-sec') === 45, '修改总体硬超时为 45 秒成功');

    // 恢复默认值
    ext._settings.set_int('inactivity-timeout-sec', 5);
    ext._settings.set_int('overall-timeout-sec', 15);
    assert(ext._settings.get_int('inactivity-timeout-sec') === 5, '恢复默认 5 秒成功');
    assert(ext._settings.get_int('overall-timeout-sec') === 15, '恢复默认 15 秒成功');

    ext.disable();
});

await reporter.run('11.7 在途传输中动态修改总体超时 (overall-timeout-sec) 动态生效测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    let streamCancelled = false;
    class SlowTransferSource {
        get_mimetypes() { return ['text/plain']; }
        async read_async(_mime, _cancellable) {
            return {
                read_bytes_async(_count, _priority, cancellable) {
                    return new Promise((resolve, reject) => {
                        if (cancellable) {
                            cancellable.connect(() => {
                                streamCancelled = true;
                                reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                            });
                        }
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                            if (cancellable && cancellable.is_cancelled()) return GLib.SOURCE_REMOVE;
                            resolve(new GLib.Bytes(new Uint8Array(10)));
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                }
            };
        }
    }

    ext._settings.set_int('overall-timeout-sec', 10);
    const readPromise = ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new SlowTransferSource());

    // 动态下发设置变更
    ext._settings.set_int('overall-timeout-sec', 2);
    assert(ext._settings.get_int('overall-timeout-sec') === 2, '总体超时配置已动态变更为 2 秒');

    await readPromise;
    ext._settings.reset('overall-timeout-sec');
    ext.disable();
});

// ============================================================================
// SUITE 12: 纯内存 Radix Raw 前缀树存储内核测试 (前缀分裂、内存共享、全量查重、向上收缩合并)
// ============================================================================
reporter.suite('12. 纯内存 Radix Raw 前缀树存储内核测试 (前缀分裂、内存共享、全量查重、向上收缩合并)');

await reporter.run('12.1 字节级 LCP 匹配精确度测试 (空字节、单字节、完全相等、倒数第一字节不等、中间不等)', async () => {
    const enc = new TextEncoder();
    const b1 = new GLib.Bytes(enc.encode('Prefix-Common-Header-Data-12345'));
    const b2 = new GLib.Bytes(enc.encode('Prefix-Common-Header-Data-99999'));
    const lcp = findLongestCommonPrefix(b1, b2);
    assert(lcp === 26, `LCP 应当精确匹配 26 字节前缀，实际: ${lcp}`);

    const bEmpty = new GLib.Bytes(new Uint8Array(0));
    assert(findLongestCommonPrefix(bEmpty, b1) === 0, '空流与非空流 LCP 为 0');
    assert(findLongestCommonPrefix(b1, b1) === b1.get_size(), '完全相同流 LCP 为完整大小');
});

await reporter.run('12.2 RadixRawTree 前缀自动分裂与多分支挂载 (三个具有公共前缀的条目)', async () => {
    const tree = new RadixRawTree();
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    function dummyEntry(node, name) {
        return {
            name,
            _radixNode: node,
            getBytes() {
                const segs = node.collectPathSegments();
                if (segs.length === 1) return segs[0];
                const out = Gio.MemoryOutputStream.new_resizable();
                for (const s of segs) out.write_bytes(s, null);
                out.close(null);
                return out.steal_as_bytes();
            }
        };
    }

    const bAlpha = new GLib.Bytes(enc.encode('https://example.com/api/v1/users'));
    const bBeta = new GLib.Bytes(enc.encode('https://example.com/api/v1/posts'));
    const bGamma = new GLib.Bytes(enc.encode('https://example.com/api/v1/comments'));

    const r1 = tree.insert('text/plain', bAlpha, n => dummyEntry(n, 'Alpha'));
    assert(!r1.isDuplicate, 'Alpha 首次插入不是重复项');

    const r2 = tree.insert('text/plain', bBeta, n => dummyEntry(n, 'Beta'));
    assert(!r2.isDuplicate, 'Beta 插入成功');

    const r3 = tree.insert('text/plain', bGamma, n => dummyEntry(n, 'Gamma'));
    assert(!r3.isDuplicate, 'Gamma 插入成功');

    // 验证前缀树节点拓扑
    const root = tree._getRoot('text/plain');
    assert(root.children.size === 1, '根节点下应仅有 1 个公共前缀节点分支');

    const commonPrefixNode = root.children.values().next().value;
    assert(dec.decode(commonPrefixNode.bytes.get_data()) === 'https://example.com/api/v1/', '公共前缀节点应精确收敛至共通路径');
    assert(commonPrefixNode.children.size === 3, '公共前缀节点下应分化出 3 个后缀叶子分支');

    // 验证各条目重建 bytes 100% 还原
    assert(dec.decode(r1.newEntry.getBytes().get_data()) === 'https://example.com/api/v1/users', 'Alpha 数据精确还原');
    assert(dec.decode(r2.newEntry.getBytes().get_data()) === 'https://example.com/api/v1/posts', 'Beta 数据精确还原');
    assert(dec.decode(r3.newEntry.getBytes().get_data()) === 'https://example.com/api/v1/comments', 'Gamma 数据精确还原');
});

await reporter.run('12.3 RadixRawTree 100% 重复插入直接命中已有条目 (Duplicate 零重复分配)', async () => {
    const tree = new RadixRawTree();
    const enc = new TextEncoder();
    const bOriginal = new GLib.Bytes(enc.encode('Repeated Payload 123'));
    const bDuplicate = new GLib.Bytes(enc.encode('Repeated Payload 123'));

    const r1 = tree.insert('text/plain', bOriginal, n => ({ id: 'entry-1', _radixNode: n }));
    assert(!r1.isDuplicate, '首次插入');

    const r2 = tree.insert('text/plain', bDuplicate, n => ({ id: 'entry-dup', _radixNode: n }));
    assert(r2.isDuplicate === true, '二次插入相同数据必须命中重复');
    assert(r2.existingEntry.id === 'entry-1', '返回的必须是已有条目实例');
});

await reporter.run('12.4 RadixRawTree 短串作为长串前缀插入 (先长后短与先短后长自适应分裂)', async () => {
    const tree = new RadixRawTree();
    const enc = new TextEncoder();

    // 1. 先长后短
    const bLong = new GLib.Bytes(enc.encode('SELECT * FROM database.users WHERE id = 1'));
    const bShort = new GLib.Bytes(enc.encode('SELECT * FROM database.users'));

    const rLong = tree.insert('text/plain', bLong, n => ({ id: 'long', _radixNode: n }));
    const rShort = tree.insert('text/plain', bShort, n => ({ id: 'short', _radixNode: n }));

    assert(!rLong.isDuplicate && !rShort.isDuplicate, '两者皆非重复项');
    assert(rShort.newEntry._radixNode.entry === rShort.newEntry, '短串作为前缀节点本身挂载为条目');
    assert(rShort.newEntry._radixNode.children.size === 1, '短串节点包含长串后缀子节点');

    // 2. 查重短串
    const rShortDup = tree.insert('text/plain', bShort, () => {});
    assert(rShortDup.isDuplicate && rShortDup.existingEntry.id === 'short', '短串能被独立精准查重');

    // 3. 查重长串
    const rLongDup = tree.insert('text/plain', bLong, () => {});
    assert(rLongDup.isDuplicate && rLongDup.existingEntry.id === 'long', '长串能被独立精准查重');
});

await reporter.run('12.5 RadixRawTree 条目删除后沿树向上剪枝合并 (叶子删除、单分支父子自动收缩合并)', async () => {
    const tree = new RadixRawTree();
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    function entryWithRebuild(node, id) {
        return {
            id,
            _radixNode: node,
            getBytes() {
                const segs = node.collectPathSegments();
                if (segs.length === 1) return segs[0];
                const out = Gio.MemoryOutputStream.new_resizable();
                for (const s of segs) out.write_bytes(s, null);
                out.close(null);
                return out.steal_as_bytes();
            }
        };
    }

    const b1 = new GLib.Bytes(enc.encode('Header-Alpha'));
    const b2 = new GLib.Bytes(enc.encode('Header-Beta'));

    const r1 = tree.insert('text/plain', b1, n => entryWithRebuild(n, 'E1'));
    const r2 = tree.insert('text/plain', b2, n => entryWithRebuild(n, 'E2'));

    // 此时公共前缀为 'Header-'，有两个子分支 'Alpha' 和 'Beta'
    const root = tree._getRoot('text/plain');
    const commonNode = root.children.values().next().value;
    assert(commonNode.children.size === 2, '分裂为 2 个分支');

    // 删除 E2 ('Header-Beta')
    tree.remove(r2.newEntry);

    // 验证收缩合并：仅剩 E1 时，'Header-' 与 'Alpha' 自动向上收缩合并为单条路径 'Header-Alpha'
    assert(root.children.size === 1, '根节点下保持 1 个分支');
    const mergedNode = root.children.values().next().value;
    assert(dec.decode(mergedNode.bytes.get_data()) === 'Header-Alpha', '单分支自动收缩合并为完整字符串');
    assert(dec.decode(r1.newEntry.getBytes().get_data()) === 'Header-Alpha', '剩余条目数据还原依然 100% 完好');

    // 删除剩余的 E1
    tree.remove(r1.newEntry);
    assert(root.children.size === 0, '全部条目删除后，根节点完全清理归零');
});

await reporter.run('12.6 Extension 端到端前缀共享内存重构与回灌正确性验证 (复制共享99%前缀的大对象与完整还原)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 生成 100KB 数据 A 与 B (共享 ~90KB 前缀)
    const common100KB = 'PREFIX-DATA-CHUNK-'.repeat(5000);
    const payloadA = common100KB + 'SUFFIX-A-12345';
    const payloadB = common100KB + 'SUFFIX-B-67890';

    const srcA = new MockSelectionSource(['text/plain'], new TextEncoder().encode(payloadA));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA);
    assert(getExtItemCount(ext) === 1, '条目 A 入库成功');

    const srcB = new MockSelectionSource(['text/plain'], new TextEncoder().encode(payloadB));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcB);
    assert(getExtItemCount(ext) === 2, '条目 B 入库成功，未被误判为重复');

    // 验证前缀树底层确实进行了前缀共享
    const radix = ext._radixTree;
    const root = radix._getRoot('text/plain');
    assert(root.children.size === 1, '两长条目在 Radix 树中成功共享同一公共前缀节点！');

    // 验证 bytes getter 按需重构还原的一致性
    const itemB = ext._getEntry(0); // 队首是 B
    const itemA = ext._getEntry(1); // 队尾是 A

    const textA = new TextDecoder().decode(itemA.bytes.get_data());
    const textB = new TextDecoder().decode(itemB.bytes.get_data());
    assert(textA === payloadA, 'A 的 bytes 100% 完整重构还原，无数据丢失');
    assert(textB === payloadB, 'B 的 bytes 100% 完整重构还原，无数据丢失');

    // 再次复制 A：触发 Radix 查重与 LRU 提升
    const srcA_dup = new MockSelectionSource(['text/plain'], new TextEncoder().encode(payloadA));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA_dup);
    assert(getExtItemCount(ext) === 2, '条数不增加');
    assert(ext._getEntry(0).id === itemA.id, 'A 被精准识别并提升至队首');

    ext.disable();
});

await reporter.run('12.7 惰性物化与按需组装验证 (使用 size 统计配额与校验，严防入库和校验时提前组装 bytes)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 验证 reduce 统计总容量时通过 item.size 计算，绝不触发 bytes getter
    let bytesGetterCalled = false;
    const mockSplitItem = {
        size: 1024 * 1024,
        get bytes() {
            bytesGetterCalled = true;
            return new GLib.Bytes(new Uint8Array(1024 * 1024));
        }
    };

    const calcSum = [mockSplitItem].reduce(
        (sum, item) => sum + (typeof item.size === 'number' ? item.size : (item.bytes ? item.bytes.get_size() : 0)), 0
    );
    assert(calcSum === 1024 * 1024, '容量统计使用 item.size 正确累加');
    assert(bytesGetterCalled === false, '_enforceLimit 计算过程严禁触发 bytes getter 物化！');

    // 2. 验证 _restoreEntry 入口有效性校验使用 size，无效条目不触碰 bytes
    let invalidBytesTouched = false;
    ext._restoreEntry({ size: 0, get bytes() { invalidBytesTouched = true; return null; } });
    assert(invalidBytesTouched === false, 'size <= 0 无效条目提前退出，不访问 bytes');

    // 3. 验证 _restoreEntry 真实执行回灌时才按需访问 bytes
    let validBytesTouched = false;
    const validEntry = {
        mime: 'text/plain',
        size: 11,
        get bytes() {
            validBytesTouched = true;
            return new GLib.Bytes(new TextEncoder().encode('LazyRestore'));
        }
    };
    ext._restoreEntry(validEntry);
    assert(validBytesTouched === true, '真正执行回灌操作时才按需触发 bytes 物化');

    // 4. 端到端验证：复制共享前缀条目，检查条目具备 size 属性且未损坏
    const prefix = 'SHARED-LAZY-PREFIX-DATA-';
    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(prefix + '11111'));
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode(prefix + '22222'));

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);

    const item2 = ext._getEntry(0);
    const item1 = ext._getEntry(1);

    assert(typeof item2.size === 'number' && item2.size > 0, '条目 2 具备正整数 size 属性');
    assert(typeof item1.size === 'number' && item1.size > 0, '条目 1 具备正整数 size 属性');
    assert(item2._radixNode.collectPathSegments().length > 1, '条目 2 发生了前缀分裂，路径段数 > 1');
    assert(item1._radixNode.collectPathSegments().length > 1, '条目 1 发生了前缀分裂，路径段数 > 1');

    ext.disable();
});

await reporter.run('12.8 makeSliceBytes 独立字节切片与母体强引用彻底解绑测试 (根除 GLib.Bytes.new_from_bytes 内存泄漏缺陷)', async () => {
    // 1. 全量复用零拷贝校验
    const rawData = new Uint8Array([10, 20, 30, 40, 50]);
    const srcBytes = new GLib.Bytes(rawData);
    const fullSlice = makeSliceBytes(srcBytes, rawData, 0, 5);
    assert(fullSlice === srcBytes, '全量引用时直接返回源实例，零拷贝零冗余');

    // 2. 切片断开母体引用校验
    const subSlice = makeSliceBytes(srcBytes, rawData, 1, 3); // [20, 30, 40]
    assert(subSlice !== srcBytes, '切片时返回独立新分配的 GLib.Bytes 实例');
    assert(subSlice.get_size() === 3, '切片尺寸精确为 3');
    const subData = subSlice.get_data();
    assert(subData[0] === 20 && subData[1] === 30 && subData[2] === 40, '切片数据内容 100% 精确');

    // 3. RadixRawTree 分裂时切片独立性验证
    const tree = new RadixRawTree();
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const payloadA = new Uint8Array(1000);
    payloadA.fill(65); // 'A' x 1000
    payloadA.set(enc.encode('TAIL_ONE'), 990);
    const bytesA = new GLib.Bytes(payloadA);

    const payloadB = new Uint8Array(1000);
    payloadB.fill(65); // 'A' x 1000
    payloadB.set(enc.encode('TAIL_TWO'), 990);
    const bytesB = new GLib.Bytes(payloadB);

    function makeEntry(node, id) {
        return {
            id,
            _radixNode: node,
            getBytes() {
                const segs = node.collectPathSegments();
                if (segs.length === 1) return segs[0];
                const out = Gio.MemoryOutputStream.new_resizable();
                for (const s of segs) out.write_bytes(s, null);
                out.close(null);
                return out.steal_as_bytes();
            }
        };
    }

    const rA = tree.insert('application/octet-stream', bytesA, n => makeEntry(n, 'EA'));
    const rB = tree.insert('application/octet-stream', bytesB, n => makeEntry(n, 'EB'));

    const root = tree._getRoot('application/octet-stream');
    const commonNode = root.children.values().next().value;
    assert(commonNode.bytes.get_size() === 995, '公共前缀长度为 995');

    // 验证分裂节点持有的是独立切片 bytes，而非 parent 引用
    const childNodes = Array.from(commonNode.children.values());
    assert(childNodes.length === 2, '两个分叉子节点');
    for (const child of childNodes) {
        assert(child.bytes.get_size() === 5, '各自分叉后缀精确占 5 字节，而非引用整个 1000 字节母体');
    }

    // 验证淘汰 EA 后，EB 依然完好
    tree.remove(rA.newEntry);
    assert(rB.newEntry.getBytes().get_size() === 1000, 'EB 总尺寸保持 1000 字节');
    assert(dec.decode(rB.newEntry.getBytes().get_data().subarray(990, 998)) === 'TAIL_TWO', 'EA 淘汰释放后 EB 数据无损');
});

await reporter.run('12.9 复制时间戳实时记录与重复项目提升队首时间更新测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 复制首个条目 A
    const t0 = Date.now();
    const srcA = new MockSelectionSource(['text/plain'], new TextEncoder().encode('ITEM-ALPHA'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA);
    const itemA = ext._getEntry(0);
    assert(itemA !== null, '条目 A 正常入库');
    assert(typeof itemA.time === 'number', 'itemA 包含数字型复制时间戳');
    assert(itemA.time >= t0, 'itemA.time 准确记录捕获时刻的时间');
    assert(Object.isFrozen(itemA), 'itemA 对象处于冻结状态');

    // 等待 15ms 保证时间戳递增
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => { r(); return GLib.SOURCE_REMOVE; }));

    // 2. 复制第二个条目 B
    const srcB = new MockSelectionSource(['text/plain'], new TextEncoder().encode('ITEM-BETA'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcB);
    const itemB = ext._getEntry(0);
    assert(itemB.time > itemA.time, '后复制的条目 B 时间戳大于 A');

    // 等待 15ms
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => { r(); return GLib.SOURCE_REMOVE; }));

    // 3. 再次复制条目 A：触发去重，A 提升至队首，复制时间戳更新为最新时刻
    const tDupA = Date.now();
    const srcADup = new MockSelectionSource(['text/plain'], new TextEncoder().encode('ITEM-ALPHA'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcADup);
    assert(getExtItemCount(ext) === 2, '历史总数保持为 2');
    assert(ext._getEntry(0).id === itemA.id, '条目 A 被提升至队首');
    assert(ext._getEntry(0).time >= tDupA, '条目 A 的复制时间更新为重复复制那一刻的时间');
    assert(ext._getEntry(0).time > itemB.time, '更新后条目 A 的时间大于条目 B');
    assert(Object.isFrozen(ext._getEntry(0)), '提升至队首后条目仍保持不可篡改与 Object.isFrozen 保护');

    // 等待 15ms
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => { r(); return GLib.SOURCE_REMOVE; }));

    // 4. 重复复制当前已在队首的条目 A：再次更新复制时间
    const tHeadDup = Date.now();
    const srcAHeadDup = new MockSelectionSource(['text/plain'], new TextEncoder().encode('ITEM-ALPHA'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcAHeadDup);
    assert(getExtItemCount(ext) === 2, '队首重复复制历史总数保持为 2');
    assert(ext._getEntry(0).id === itemA.id, '依然为队首条目 A');
    assert(ext._getEntry(0).time >= tHeadDup, '队首重复复制时复制时间戳更新为当前复制时刻');

    ext.disable();
});

await reporter.run('12.10 复制时间在弹窗中显示与 formatTime 格式化单元测试', async () => {
    // 1. formatTime 格式化函数边界容错验证
    assert(formatTime(null) === '', 'null 格式化为空字符串');
    assert(formatTime(undefined) === '', 'undefined 格式化为空字符串');
    assert(formatTime(0) === '', '0 格式化为空字符串');
    assert(formatTime(NaN) === '', 'NaN 格式化为空字符串');
    assert(formatTime('invalid') === '', '字符串入参格式化为空字符串');

    const now = Date.now();
    const formattedNow = formatTime(now);
    assert(/^\d{2}:\d{2}:\d{2}$/.test(formattedNow), `当天时间戳应格式化为 HH:mm:ss，实际: ${formattedNow}`);

    // 跨天时间戳验证 (24小时前与48小时前)
    const yesterday = now - 24 * 60 * 60 * 1000;
    const formattedYesterday = formatTime(yesterday);
    assert(/^\d+天前 \d{2}:\d{2}$/.test(formattedYesterday), `跨天时间戳应格式化为 n天前 HH:mm，实际: ${formattedYesterday}`);
    assert(formattedYesterday.startsWith('1天前 '), `24小时前应显示 1天前，实际: ${formattedYesterday}`);

    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    const formattedTwoDaysAgo = formatTime(twoDaysAgo);
    assert(formattedTwoDaysAgo.startsWith('2天前 '), `48小时前应显示 2天前，实际: ${formattedTwoDaysAgo}`);

    // 2. 弹窗 UI 中显示条目复制时间
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Timed Item 1'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);

    const item1 = getExtItem(ext, 0);
    assert(item1 !== null, '条目 1 入库成功');
    assert(item1.time !== null && item1.time !== '', '弹窗中必须包含复制时间标签');
    assert(/^\d{2}:\d{2}:\d{2}$/.test(item1.time), `弹窗中的复制时间格式应为 HH:mm:ss，实际: ${item1.time}`);

    // 3. 复制重复条目时，弹窗中的时间标签即时更新
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => { r(); return GLib.SOURCE_REMOVE; }));
    const src1Dup = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Timed Item 1'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1Dup);

    const item1Dup = getExtItem(ext, 0);
    assert(item1Dup.time !== null, '重复条目在弹窗中依然保留复制时间');

    ext.disable();
});

await reporter.run('12.11 未知类型元数据raw分树与“未知类型1”“未知类型2”不预览展示测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 复制第一个未知类型 (application/x-custom-type-alpha)
    const rawData1 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const srcAlpha1 = new MockSelectionSource(['application/x-custom-type-alpha'], rawData1);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcAlpha1);

    assert(getExtItemCount(ext) === 1, '未知类型 Alpha 1 入库成功');
    const itemAlpha1 = getExtItem(ext, 0);
    assert(itemAlpha1.title === '未知类型1', `未知类型首个条目标题应为未知类型1，实际: ${itemAlpha1.title}`);
    assert(itemAlpha1.subtitle === '4 B', `未知类型副标题仅显示大小，实际: ${itemAlpha1.subtitle}`);
    assert(itemAlpha1.time !== null && itemAlpha1.time !== '', '未知类型条目必须展示复制时间');
    assert(itemAlpha1.iconName === 'application-x-generic-symbolic', '未知类型使用通用二进制图标');

    // 验证 Radix 前缀树按元数据的 raw 数据分树
    assert(ext._radixTree.hasRoot('application/x-custom-type-alpha'), 'Radix树为 application/x-custom-type-alpha 分配专属独立根节点');

    // 2. 复制第二个不同的未知类型 (application/x-custom-type-beta)
    const rawData2 = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const srcBeta1 = new MockSelectionSource(['application/x-custom-type-beta'], rawData2);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcBeta1);

    assert(getExtItemCount(ext) === 2, '未知类型 Beta 1 入库成功');
    const itemBeta1 = getExtItem(ext, 0);
    assert(itemBeta1.title === '未知类型2', `新的未知类型标题应递增为未知类型2，实际: ${itemBeta1.title}`);
    assert(itemBeta1.subtitle === '3 B', `未知类型2 副标题显示大小 3 B，实际: ${itemBeta1.subtitle}`);
    assert(itemBeta1.time !== null, '未知类型2 正常展示复制时间');

    // 验证两棵树彼此独立
    assert(ext._radixTree.hasRoot('application/x-custom-type-beta'), 'Radix树为 application/x-custom-type-beta 分配独立根节点');
    assert(ext._radixTree.rootCount >= 2, '两套不同未知类型元数据严格分树隔离');

    // 3. 再次复制已知的第一个未知类型 (application/x-custom-type-alpha) 的新数据（不同内容）
    const rawData3 = new Uint8Array([0x01, 0x02, 0xEE, 0xFF]);
    const srcAlpha2 = new MockSelectionSource(['application/x-custom-type-alpha'], rawData3);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcAlpha2);

    assert(getExtItemCount(ext) === 3, '未知类型 Alpha 2 入库成功');
    const itemAlpha2 = getExtItem(ext, 0);
    assert(itemAlpha2.title === '未知类型1', `同类型元数据仍使用相同类型编号未知类型1，实际: ${itemAlpha2.title}`);
    assert(itemAlpha2.subtitle === '4 B', `大小为 4 B，实际: ${itemAlpha2.subtitle}`);

    // 验证两者进入同一棵前缀树并共享前缀 [0x01, 0x02]
    const alphaRoot = ext._radixTree.getRoot('application/x-custom-type-alpha');
    assert(alphaRoot !== null, 'Alpha 树根节点存在');
    assert(alphaRoot.children.has(0x01), 'Alpha 树共享首字节 0x01 前缀');

    // 4. 重复复制完全相同数据 -> 触发去重与时间更新
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15, () => { r(); return GLib.SOURCE_REMOVE; }));
    const tDup = Date.now();
    const srcAlpha2Dup = new MockSelectionSource(['application/x-custom-type-alpha'], rawData3);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcAlpha2Dup);

    assert(getExtItemCount(ext) === 3, '重复复制未知类型不增加总条目数');
    assert(ext._getEntry(0).time >= tDup, '重复复制未知类型更新复制时间戳');

    // 5. 验证未知类型回灌至系统剪贴板保持 raw 元数据与字节无损
    const restoredEntry = ext._getEntry(0);
    ext._restoreEntry(restoredEntry);
    assert(restoredEntry.mime === 'application/x-custom-type-alpha', '回灌保持原始声明的未知类型元数据');
    assert(restoredEntry.bytes.get_size() === 4, '回灌保持原始二进制数据大小');

    ext.disable();
});

await reporter.run('12.12 四种排序方式 (记录顺序/大小/类型/首字母) 与槽位复用零闪烁渲染测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. 准备多类型、多大小、多首字母测试数据
    // 条目 1: 中文文本 (记录 #1, 大小: 18B, type: text)
    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('中文测试项目'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);

    // 条目 2: 英文 Banana (记录 #2, 大小: 6B, type: text, preview: Banana)
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Banana'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);

    // 条目 3: 英文 Apple (记录 #3, 大小: 5B, type: text, preview: Apple)
    const src3 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Apple'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src3);

    // 条目 4: HTML 数据 (记录 #4, 大小: 25B, type: html)
    const src4 = new MockSelectionSource(['text/html'], new TextEncoder().encode('<b>Hello HTML world</b>'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src4);

    // 条目 5: 英文 Cat (记录 #5, 大小: 3B, type: text, preview: Cat)
    const src5 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Cat'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src5);

    // 打开弹窗
    ext._openPopup();
    assert(ext.sortMode === 'queue', '初始排序模式为记录顺序 (queue)');

    // 验证按钮标签文本
    const queueBtn = ext._sortButtons.get('queue');
    const sizeBtn = ext._sortButtons.get('size');
    const typeBtn = ext._sortButtons.get('type');
    const initialBtn = ext._sortButtons.get('initial');
    assert(queueBtn.get_children()[0].text === '记录顺序', 'queue 按钮文本为 记录顺序');
    assert(sizeBtn.get_children()[0].text === '大小', 'size 按钮文本为 大小');
    assert(typeBtn.get_children()[0].text === '类型', 'type 按钮文本为 类型');
    assert(initialBtn.get_children()[0].text === '首字母', 'initial 按钮文本为 首字母');
    assert(queueBtn.get_children()[0].reactive === false, '按钮标签具有 reactive: false 避免遮挡点击');

    // 2. 模式 1: 记录顺序 (FIFO/LRU: Cat -> <b>Hello... -> Apple -> Banana -> 中文测试项目)
    let visibleTitles = ext._itemActors.map(a => a.get_children()[1].get_children()[0].text);
    assert(visibleTitles[0] === 'Cat', '队首为最新记录的 Cat');
    assert(visibleTitles[1] === '<b>Hello HTML world</b>', '第2项为 HTML');
    assert(visibleTitles[2] === 'Apple', '第3项为 Apple');
    assert(visibleTitles[3] === 'Banana', '第4项为 Banana');
    assert(visibleTitles[4] === '中文测试项目', '末项为最早记录的 中文测试项目');

    // 3. 模式 2: 按大小排序 (size 降序: 25B(HTML) -> 18B(中文) -> 6B(Banana) -> 5B(Apple) -> 3B(Cat))
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Tab, get_state: () => 0 });
    assert(ext.sortMode === 'size', 'Tab 切换到按大小排序 (size)');
    visibleTitles = ext._itemActors.map(a => a.get_children()[1].get_children()[0].text);
    assert(visibleTitles[0] === '<b>Hello HTML world</b>', '最大条目(HTML)排第1');
    assert(visibleTitles[1] === '中文测试项目', '中文(18B)排第2');
    assert(visibleTitles[2] === 'Banana', 'Banana(6B)排第3');
    assert(visibleTitles[3] === 'Apple', 'Apple(5B)排第4');
    assert(visibleTitles[4] === 'Cat', 'Cat(3B)排第5');

    // 4. 模式 3: 按类型排序 (text(rank 1) -> html(rank 2))
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Tab, get_state: () => 0 });
    assert(ext.sortMode === 'type', 'Tab 切换到按类型排序 (type)');
    visibleTitles = ext._itemActors.map(a => a.get_children()[1].get_children()[0].text);
    // 前4项是 text (按原记录顺序相对排列: Cat, Apple, Banana, 中文测试项目)
    assert(visibleTitles[0] === 'Cat', 'text 类型优先排在最前');
    assert(visibleTitles[4] === '<b>Hello HTML world</b>', 'html 类型排在 text 之后');

    // 5. 模式 4: 按首字母排序 (仅英文排前面 A-Z，其他非英文排在英文后面按记录顺序排序)
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Tab, get_state: () => 0 });
    assert(ext.sortMode === 'initial', 'Tab 切换到按首字母排序 (initial)');
    visibleTitles = ext._itemActors.map(a => a.get_children()[1].get_children()[0].text);
    // 英文开头项: Apple (A), Banana (B), Cat (C) 排在最前
    assert(visibleTitles[0] === 'Apple', 'A 开头排第1');
    assert(visibleTitles[1] === 'Banana', 'B 开头排第2');
    assert(visibleTitles[2] === 'Cat', 'C 开头排第3');
    // 非英文字符开头: <b>Hello... (符号<), 中文测试项目 排在英文后面，按原本记录顺序
    assert(visibleTitles[3] === '<b>Hello HTML world</b>', '非英文字符项排在英文后面，保持队列顺序');
    assert(visibleTitles[4] === '中文测试项目', '中文排在最后');

    // 6. Shift+Tab 反向循环测试
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Tab, get_state: () => Clutter.ModifierType.SHIFT_MASK });
    assert(ext.sortMode === 'type', 'Shift+Tab 反向切换回类型排序');

    // 7. 鼠标左键点击/按下顶栏排序按钮测试 (验证 button-press-event 与 clicked 支持)
    const mousePressEvent = { get_button: () => 1 };
    const stopResult = sizeBtn.emit('button-press-event', mousePressEvent);
    assert(stopResult === Clutter.EVENT_STOP, '点击排序按钮返回 EVENT_STOP 阻断冒泡');
    assert(ext.sortMode === 'size', '鼠标点击大小按钮成功切换排序为 size');
    assert(sizeBtn.style_classes.includes('active'), 'size 按钮处于 active 状态');
    assert(!typeBtn.style_classes.includes('active'), 'type 按钮移除了 active 状态');

    // 点击“记录顺序”按钮
    queueBtn.emit('button-press-event', mousePressEvent);
    assert(ext.sortMode === 'queue', '鼠标点击记录顺序按钮成功切换回 queue');
    assert(queueBtn.style_classes.includes('active'), 'queue 按钮处于 active 状态');

    // 8. 槽位复用 (Slot Pool) 零闪烁测试
    const slot0Actor = ext._itemSlots[0].itemBox;
    const slot0Icon = ext._itemSlots[0].iconActor;
    // 触发重新渲染
    ext._renderPage();
    assert(ext._itemSlots[0].itemBox === slot0Actor, '重新渲染后槽位容器完全复用');
    assert(ext._itemSlots[0].iconActor === slot0Icon, '重新渲染后 Icon 材质完全复用，杜绝销毁重建闪烁');

    ext._closePopup();
    ext.disable();
});

// ============================================================================
// SUITE 13: 预览内搜索与按键交互自动化测试 (In-Preview Search & UI Interaction)
// ============================================================================
reporter.suite('13. 预览内搜索与按键交互自动化测试 (键入唤出、仅匹配文本预览、删光无匹配、空白退出、循环翻页)');

await reporter.run('13.1 键入文字自动唤出搜索栏替代排序栏，搜索框平时隐藏', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 写入条目
    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Hello World'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);

    ext._openPopup();
    assert(ext._inSearchMode === false, '弹窗打开时默认不在搜索状态');
    assert(ext._sortBar.visible === true, '排序栏默认可见');
    assert(ext._searchBar.visible === false, '搜索栏默认隐藏');

    // 键入字符 'h'
    const event = {
        get_key_symbol: () => 104, // 'h'
        get_state: () => 0,
        get_key_unicode: () => 104,
    };
    const res = ext._onKeyPress(event);
    assert(res === Clutter.EVENT_STOP, '键入字符消费事件并进入搜索');
    assert(ext._inSearchMode === true, '进入搜索状态');
    assert(ext.searchQuery === 'h', '搜索词为 h');
    assert(ext._searchEntry.text === 'h', '搜索输入框显示 h');
    assert(ext._searchBar.visible === true, '搜索栏变为可见');
    assert(ext._sortBar.visible === false, '排序栏被隐藏替代');

    ext._closePopup();
    ext.disable();
});

await reporter.run('13.2 关键字仅匹配能以文本形式预览的项目 (text, html, files)，位图与未知类型绝不匹配，结果以记录顺序排序', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. text: "Apple juice"
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/plain'], new TextEncoder().encode('Apple juice')));
    // 2. html: "<b>Super Apple pie</b>"
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/html'], new TextEncoder().encode('<b>Super Apple pie</b>')));
    // 3. files: "file:///home/user/apple_note.txt"
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/uri-list'], new TextEncoder().encode('file:///home/user/apple_note.txt\n')));
    // 4. image: PNG 位图 (即使文件名或元数据有 apple，类型为 image 绝不匹配)
    const pb = new GdkPixbuf.Pixbuf({ colorspace: GdkPixbuf.Colorspace.RGB, has_alpha: true, bits_per_sample: 8, width: 32, height: 32 });
    pb.fill(0xff0000ff);
    const [, pngBuf] = pb.save_to_bufferv('png', [], []);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['image/png'], pngBuf));
    // 5. raw: 未知类型
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['application/x-apple-raw'], new Uint8Array([1, 2, 3])));

    ext._openPopup();
    assert(ext._getVisibleEntries().length === 5, '全部 5 项入库');

    // 键入 'apple'
    ext._enterSearchMode('apple');
    const matched = ext._getSortedEntries();
    assert(matched.length === 3, `仅匹配 3 项能以文本预览的项目，实际: ${matched.length}`);
    // 结果必须以记录顺序 (LRU 队首到队尾: files -> html -> text) 排序
    assert(matched[0].type === 'files', '第 1 项为 files (按最新记录顺序)');
    assert(matched[1].type === 'html', '第 2 项为 html');
    assert(matched[2].type === 'text', '第 3 项为 text');

    // 确认位图与未知类型未被匹配
    assert(!matched.some(e => e.type === 'image'), '位图类型绝不匹配');
    assert(!matched.some(e => e.type === 'raw'), '未知类型绝不匹配');

    ext._closePopup();
    ext.disable();
});

await reporter.run('13.3 搜索框字符删光时不退出搜索状态，但显示无匹配项目，而不是显示全部项目', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/plain'], new TextEncoder().encode('Sample Text')));
    ext._openPopup();

    // 键入 's'
    ext._onKeyPress({ get_key_symbol: () => 115, get_state: () => 0, get_key_unicode: () => 115 });
    assert(ext._inSearchMode === true, '进入搜索状态');
    assert(ext._getSortedEntries().length === 1, '匹配 1 项');

    // 按 BackSpace 删光字符
    const backspaceEvent = { get_key_symbol: () => Clutter.KEY_BackSpace, get_state: () => 0 };
    ext._onKeyPress(backspaceEvent);

    assert(ext._inSearchMode === true, '字符删光时依然处于搜索状态，绝不退出搜索');
    assert(ext.searchQuery === '', '搜索词变为空');
    assert(ext._searchEntry.text === '', '搜索输入框为空');
    assert(ext._getSortedEntries().length === 0, '搜索词为空时返回 0 项 (空列表)');
    assert(ext._emptyLabel && ext._emptyLabel.visible === true, '显示空列表标签');
    assert(ext._emptyLabel.text === '无匹配项目', `空标签文本应为 无匹配项目，实际: ${ext._emptyLabel.text}`);

    ext._closePopup();
    ext.disable();
});

await reporter.run('13.4 按 Esc 键先退出搜索状态回到完整列表且不关闭弹窗，再次按 Esc 才关闭弹窗', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item 1')));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item 2')));
    ext._openPopup();

    ext._enterSearchMode('Item');
    assert(ext._inSearchMode === true, '处于搜索状态');

    // 第一次按 Esc: 退出搜索状态
    const escEvent = { get_key_symbol: () => Clutter.KEY_Escape, get_state: () => 0 };
    const res1 = ext._onKeyPress(escEvent);
    assert(res1 === Clutter.EVENT_STOP, 'Esc 消费事件');
    assert(ext._inSearchMode === false, '已退出搜索状态');
    assert(ext._container !== null, '弹窗依然保持打开，未关闭');
    assert(ext._sortBar.visible === true, '排序栏恢复显示');
    assert(ext._searchBar.visible === false, '搜索栏隐藏');
    assert(ext._getSortedEntries().length === 2, '恢复显示全部历史记录');

    // 第二次按 Esc: 关闭弹窗
    const res2 = ext._onKeyPress(escEvent);
    assert(res2 === Clutter.EVENT_STOP, '第二次 Esc 消费事件');
    assert(ext._container === null, '弹窗已关闭');

    ext.disable();
});

await reporter.run('13.5 鼠标点击弹窗外或弹窗内非历史记录项目区域，先退出搜索状态而不关闭弹窗', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/plain'], new TextEncoder().encode('Note A')));
    ext._openPopup();

    // 1. 点击弹窗全屏遮罩空白处 (弹窗外)
    ext._enterSearchMode('Note');
    assert(ext._inSearchMode === true, '处于搜索状态');
    ext._container.emit('button-press-event', { get_button: () => 1 });
    assert(ext._inSearchMode === false, '点击弹窗外先退出搜索状态');
    assert(ext._container !== null, '弹窗未关闭');

    // 2. 点击弹窗背景主体 (弹窗内非条目区域)
    ext._enterSearchMode('Note');
    assert(ext._inSearchMode === true, '处于搜索状态');
    ext._popup.emit('button-press-event', { get_button: () => 1 });
    assert(ext._inSearchMode === false, '点击弹窗背景先退出搜索状态');
    assert(ext._container !== null, '弹窗未关闭');

    // 3. 点击底部页码栏
    ext._enterSearchMode('Note');
    assert(ext._inSearchMode === true, '处于搜索状态');
    ext._pageBar.emit('button-press-event', { get_button: () => 1 });
    assert(ext._inSearchMode === false, '点击底部页码栏先退出搜索状态');
    assert(ext._container !== null, '弹窗未关闭');

    ext._closePopup();
    ext.disable();
});

await reporter.run('13.6 搜索状态支持循环翻页，结果以记录顺序排序，Enter 恢复选中项', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 生成 20 个包含 "TargetMatch" 的条目
    for (let i = 1; i <= 20; i++) {
        const text = `TargetMatch Item ${i}`;
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/plain'], new TextEncoder().encode(text)));
    }
    // 生成 5 个不匹配的条目
    for (let i = 1; i <= 5; i++) {
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, new MockSelectionSource(['text/plain'], new TextEncoder().encode(`Other ${i}`)));
    }

    ext._openPopup();
    ext._enterSearchMode('targetmatch');

    const matches = ext._getSortedEntries();
    assert(matches.length === 20, '精准匹配 20 项');
    // 总页数: ceil(20 / 8) = 3 页 (第0页: 8项, 第1页: 8项, 第2页: 4项)
    assert(ext._currentPage === 0, '初始位于第 0 页');

    // 循环翻页测试：第 0 页按 Left / PageUp 翻至最后一页 (第 2 页)
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Left, get_state: () => 0 });
    assert(ext._currentPage === 2, '第 0 页向上循环翻页至末页 (第 2 页)');

    // 末页按 Right / PageDown 翻至第 0 页
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Right, get_state: () => 0 });
    assert(ext._currentPage === 0, '末页向下循环翻页至首页 (第 0 页)');

    // Enter 恢复选中条目并关闭弹窗
    ext._selectedIndex = 0;
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Return, get_state: () => 0 });
    assert(ext._container === null, 'Enter 恢复后弹窗关闭');
    assert(ext._isRestoring === false, '恢复流程顺利结束');

    ext.disable();
});

// ============================================================================
// 3. 执行最终报告汇算
// ============================================================================
const success = reporter.summary();
if (!success) {
    imports.system.exit(1);
} else {
    imports.system.exit(0);
}
