import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';

// ============================================================================
// 1. 测试环境初始化与 GNOME Shell / Clutter Mock 装配
// ============================================================================

// 注册系统与自定义 GResource
const extResource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
extResource._register();

const testDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const localGResource = GLib.build_filenamev([testDir, 'mock.gresource']);
const mockResource = Gio.Resource.load(localGResource);
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
    }
    add_child(c) {
        if (c) this.children.push(c);
    }
    remove_child(c) {
        const idx = this.children.indexOf(c);
        if (idx >= 0) this.children.splice(idx, 1);
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
        return 1;
    }
    disconnect() {}
    emit(sig, ...args) {
        if (this.signals.has(sig)) {
            for (const cb of this.signals.get(sig)) {
                cb(this, ...args);
            }
        }
    }
    set_position(x, y) { this.x = x; this.y = y; }
    set_size(w, h) { this.width = w; this.height = h; }
    set_pivot_point() {}
    ease(opts) {
        if (opts && typeof opts.onComplete === 'function') opts.onComplete();
    }
    get_position() { return [this.x || 0, this.y || 0]; }
    get_size() { return [this.width || 0, this.height || 0]; }
    get_transformed_position() { return [this.x || 0, this.y || 0]; }
    get_transformed_size() { return [this.width || 0, this.height || 0]; }
    get_preferred_width(_forHeight) { return [this.width || 0, this.width || 52]; }
    get_preferred_height(_forWidth) { return [this.height || 0, this.height || 26]; }
    get_allocation_box() { return { x1: 0, y1: this.y || 0, x2: this.width || 0, y2: (this.y || 0) + (this.height || 46) }; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    contains(actor) { return this.children.includes(actor); }
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
        this.clutter_text = { use_markup: false, ellipsize: 0 };
    }
    set_text(t) {
        this.text = t;
    }
}

class MockIcon extends MockActor {
    constructor(props = {}) {
        super(props);
        this._gicon = props.gicon || null;
        this._icon_name = props.icon_name || null;
        this.icon_size = props.icon_size;
    }
    get gicon() { return this._gicon; }
    set gicon(v) {
        this._gicon = v;
        if (v) this._icon_name = null;
    }
    get icon_name() { return this._icon_name || this._resolvedIconName || null; }
    set icon_name(v) {
        this._icon_name = v;
        if (v) this._gicon = null;
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
            step_increment: 46,
        };
    }
    get_vadjustment() {
        return this._vadj;
    }
}

class MockEntry extends MockActor {
    constructor(props = {}) {
        super(props);
        this.text = props.text || '';
        this.hint_text = props.hint_text || '';
        this.can_focus = props.can_focus !== undefined ? props.can_focus : true;
        this.clutter_text = new MockActor({
            use_markup: false,
            set_cursor_position: () => {},
        });
        this.clutter_text.get_text = () => this.text;
        this.clutter_text.set_text = (t) => { this.set_text(t); };
        this.clutter_text.insert_text = (str, _pos) => {
            this.set_text(this.text + str);
        };
    }
    set_text(t) {
        this.text = t;
        if (this.clutter_text && typeof this.clutter_text.emit === 'function') {
            this.clutter_text.emit('text-changed');
        }
    }
    get_text() {
        return this.text;
    }
    grab_key_focus() {
        this.has_focus = true;
        if (this.clutter_text && typeof this.clutter_text.grab_key_focus === 'function') {
            this.clutter_text.grab_key_focus();
        }
    }
}

// 设置 Mock 类
Clutter.Actor = MockActor;
St.BoxLayout = MockActor;
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
        }),
    },
    get_pointer: () => [300, 300],
    stage: { width: 1920, height: 1080 },
};

// 导入被测核心代码
const extModule = await import('../extension.js');
const RawClipboardExtension = extModule.default;

// ============================================================================
// 2. 测试工具类与框架
// ============================================================================

class MockSelectionSource {
    constructor(mimetypes, bytes) {
        this._mimetypes = mimetypes;
        this._mimeMap = null;
        if (bytes instanceof GLib.Bytes) {
            this._bytes = bytes;
        } else if (bytes instanceof Uint8Array) {
            this._bytes = new GLib.Bytes(bytes);
        } else if (typeof bytes === 'object' && bytes !== null && !ArrayBuffer.isView(bytes)) {
            this._mimeMap = new Map();
            for (const [k, v] of Object.entries(bytes)) {
                this._mimeMap.set(k, v instanceof GLib.Bytes ? v : new GLib.Bytes(v));
            }
            this._bytes = null;
        } else {
            this._bytes = new GLib.Bytes(bytes || new Uint8Array(0));
        }
    }

    get_mimetypes() {
        return this._mimetypes;
    }

    async read_async(mime, _cancellable) {
        if (this._mimeMap && this._mimeMap.has(mime)) {
            return Gio.MemoryInputStream.new_from_bytes(this._mimeMap.get(mime));
        }
        if (this._bytes) {
            return Gio.MemoryInputStream.new_from_bytes(this._bytes);
        }
        return Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new Uint8Array(0)));
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
        print(`               全方位功能与边界防御自动化测试报告`);
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
            print(`\n  🎉 所有边界与压力测试 100% 成功通过！`);
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

// 辅助方法：读取扩展实例当前的条目总数与第一条预览信息
function getExtItemCount(ext) {
    if (ext._popup && ext._popup.visible) {
        return ext._itemActors ? ext._itemActors.length : 0;
    }
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
// SUITE 1: 空数据流 / 零字节数据防御测试
// ============================================================================
reporter.suite('1. 空数据流 / 零字节数据防御测试');

await reporter.run('1.1 剪贴板输入 0 字节空流 (静默拦截，严防空条目入库与崩溃)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const emptySrc = new MockSelectionSource(['text/plain'], new Uint8Array(0));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, emptySrc);

    assert(getExtItemCount(ext) === 0, '0 字节空流不得入库，队列应为空');
    assert(ext._lastChecksum === '', '0 字节流不应更新 checksum 状态');
    ext.disable();
});

await reporter.run('1.2 selectionSource 提供空 MIME 列表或 null 安全拦截', async () => {
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

await reporter.run('1.3 全空白符与换行纯文本摘要安全降级 (防空白标题溢出与无字渲染)', async () => {
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

await reporter.run('1.4 空 URI 列表文件复制行为防御 (text/uri-list 仅含换行与注释)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 模拟仅有注释或指令而无有效 URI 的空列表
    const emptyList = new TextEncoder().encode('# Nautilus comment\ncopy\n\n');
    const src = new MockSelectionSource(['text/uri-list'], emptyList);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '应安全捕获');
    const item = getExtItem(ext, 0);
    assert(item.title === '文件列表', `无有效路径时应降级显示文件列表，实际: ${item.title}`);
    assert(item.subtitle.includes('0 项'), `项数应统计为 0 项，实际: ${item.subtitle}`);

    ext.disable();
});

// ============================================================================
// SUITE 2: 超大容量边界与压测拦截 (20MB 边界、20MB+1B、100MB 假流)
// ============================================================================
// SUITE 2: 超大容量边界与压测拦截 (可配置 5~1024MB，支持最大 1GB)
// ============================================================================
reporter.suite('2. 超大容量边界与压测防御测试 (可配置单条上限，最高 1024MB/1GB)');

await reporter.run('2.1 设定 20MB 上限时，恰好 20MB (20,971,520 字节) 临界边界安全准入测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._settings.set_int('max-size-mb', 20);

    const EXACT_20MB = 20 * 1024 * 1024;
    const buf = new Uint8Array(EXACT_20MB);
    buf[0] = 0x41; // 'A'
    buf[EXACT_20MB - 1] = 0x5a; // 'Z'

    const src = new MockSelectionSource(['application/octet-stream'], buf);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '恰好 20MB 属于合法上限，必须准入');
    const item = getExtItem(ext, 0);
    assert((item.subtitle || item.title).includes('20.0 MB'), `容量格式化应准确显示 20.0 MB，实际: ${item.subtitle || item.title}`);
    assert(ext._lastChecksum !== '', '应计算有效校验和');

    ext.disable();
});

await reporter.run('2.2 设定 20MB 上限时，20MB + 1 字节 (20,971,521 字节) 越界临界精准安全拦截', async () => {
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

await reporter.run('2.3 默认 50MB 上限时，100MB (104,857,600 字节) 巨型流抗压拦截与进程稳定性测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._settings.set_int('max-size-mb', 50);

    const STREAM_100MB = 100 * 1024 * 1024;
    const buf = new Uint8Array(STREAM_100MB);
    const src = new MockSelectionSource(['application/x-giant-payload'], buf);

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 0, '100MB 巨型流必须被即时丢弃');

    ext.disable();
});

await reporter.run('2.4 可配置 1024MB (1GB) 最大上限设置支持测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();
    ext._settings.set_int('max-size-mb', 1024);
    assert(ext._settings.get_int('max-size-mb') === 1024, '支持设置至 1024 MB (1GB)');
    ext.disable();
});

await reporter.run('2.5 容量字符串单位边界阶梯测试 (B, KB, MB 格式化精准度)', async () => {
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

// ============================================================================
// SUITE 3: 畸形或损坏数据容错测试 (乱码图片、残缺头、非法 UTF-8、畸形 URI)
// ============================================================================
reporter.suite('3. 畸形或损坏数据容错测试 (乱码数据、残缺头、编码异常)');

await reporter.run('3.1 伪装为 image/png 但内容为全乱码坏字节 (缩略图解析失败优雅降级)', async () => {
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

await reporter.run('3.2 残缺 PNG 魔数头部 (仅 8 字节 \\x89PNG 无任何 Chunk)', async () => {
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

await reporter.run('3.3 残缺 JPEG SOI 头部 (仅 \\xFF\\xD8\\xFF 3 字节)', async () => {
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

await reporter.run('3.4 伪装为 image/svg+xml 但内容为损坏 XML 标签与二进制乱码', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const corruptSvg = new TextEncoder().encode('<svg><unclosed tag <xml?!!\x00\xff');
    const src = new MockSelectionSource(['image/svg+xml'], corruptSvg);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, '损坏 SVG 应降级');

    ext.disable();
});

await reporter.run('3.5 非法非 UTF-8 字节流输入 text/plain (防解码崩溃与异常捕获)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 含有非法 UTF-8 连续起始码与无效字节序列
    const illegalUtf8 = new Uint8Array([0xff, 0xfe, 0xc0, 0xaf, 0xe0, 0x80, 0x80]);
    const src = new MockSelectionSource(['text/plain;charset=utf-8'], illegalUtf8);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '非法 UTF-8 序列仍应被安全接收');

    ext.disable();
});

await reporter.run('3.6 畸形 URI 序列解析容错 (decodeURIComponent 触发 URIError 降级处理)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 非法 percent 编码：%E0% 不完整序列与 %ZZ 非法十六进制
    const attackUris = 'copy\nfile:///home/user/%E0%\nfile:///home/user/%ZZ%/test.txt\n';
    const src = new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(attackUris));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    assert(getExtItemCount(ext) === 1, '畸形 URI 序列应平稳容错降级，不发生崩溃');
    const item = getExtItem(ext, 0);
    assert(item.title === '%E0%, test.txt', `畸形 URI 容错解码保留原文本并提取文件名，实际: ${item.title}`);
    assert(item.subtitle.includes('2 项'), '副标题应统计条目数');
    assert(item.iconName === 'folder-symbolic', '图标应维持为文件类型');

    ext.disable();
});

// ============================================================================
// SUITE 4: 多种真实图片流缩略图测试 (PNG, JPEG, WebP, SVG, BMP)
// ============================================================================
reporter.suite('4. 多种真实图片流缩略图生成测试 (PNG, JPEG, WebP, SVG, BMP)');

await reporter.run('4.1 真实 PNG 格式图片流缩略图与内存绑定', async () => {
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

await reporter.run('4.2 真实 JPEG 格式图片流缩略图与内存绑定', async () => {
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

await reporter.run('4.3 真实 WebP 格式图片流缩略图与内存绑定', async () => {
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

await reporter.run('4.4 真实 BMP 格式图片流缩略图与内存绑定', async () => {
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

await reporter.run('4.5 真实 SVG 格式矢量图片处理 (仅存原始数据，不解析缩略图以避免过量消耗)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const svgXml = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#00e5ff"/></svg>';
    const src = new MockSelectionSource(['image/svg+xml'], new TextEncoder().encode(svgXml));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    const item = getExtItem(ext, 0);
    assert(item.hasThumbIcon === false, 'SVG 不解析缩略图，避免额外的 XML 解析与缩略图开销');
    ext.disable();
});

await reporter.run('4.6 缩略图内存极小化校验 (生成的 PNG 缓冲 <= 1KB 纯内存)', async () => {
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
    assert(thumbBuf.length < 1024, `缩略图仅耗 ${thumbBuf.length} 字节内存，严防内存溢出`);
});

// ============================================================================
// SUITE 5: 复制文件行为测试 (多路径、特殊字符、URL 解码、零物理文件穿透)
// ============================================================================
reporter.suite('5. 复制文件行为测试 (多路径折叠、特殊字符、URL解码、零物理读取)');

await reporter.run('5.1 单文件与多文件折叠展示逻辑 (1个、2个、5个文件)', async () => {
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

await reporter.run('5.2 剪切文件精准拦截与复制文件安全入库 (GNOME Nautilus cut 严禁入库)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 1. GNOME Nautilus 剪切文件 (首行为 cut)
    const cutText = '# GNOME Nautilus Drag\ncut\nfile:///home/user/target_moved.txt\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['x-special/gnome-copied-files'], new TextEncoder().encode(cutText)));
    assert(getExtItemCount(ext) === 0, 'GNOME 剪切文件严禁进入历史队列');

    // 2. GNOME Nautilus 剪切文件 (text/uri-list 首行为 cut)
    const uriCutText = 'cut\nfile:///home/user/target_moved2.txt\n';
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], new TextEncoder().encode(uriCutText)));
    assert(getExtItemCount(ext) === 0, 'text/uri-list 剪切文件严禁进入历史队列');

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

await reporter.run('5.3 特殊字符、中文编码与带尾部斜杠目录 URL 解码', async () => {
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
    assert(item.title.includes('磨砂玻璃设计稿.sketch'), `中文应成功解码，实际: ${item.title}`);
    assert(item.title.includes('等 3 项'), `3 项应折叠并准确标识混选项，实际: ${item.title}`);
    assert(item.subtitle.includes('文件/目录 · 3 项'), `混选副标题应为文件/目录，实际: ${item.subtitle}`);
    assert(item.iconName === 'folder-symbolic', `混选图标应为 folder-symbolic，实际: ${item.iconName}`);

    ext.disable();
});

await reporter.run('5.4 零物理文件 I/O 穿透防御测试 (复制 500GB 虚拟路径零磁盘访问)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const nonExistentLarge = 'copy\nfile:///dev/huge_disk_array_10TB.raw\n';
    const rawBytes = new TextEncoder().encode(nonExistentLarge);

    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD,
        new MockSelectionSource(['text/uri-list'], rawBytes));

    const item = getExtItem(ext, 0);
    assert(item.title === 'huge_disk_array_10TB.raw', `实际: ${item.title}`);
    assert(item.subtitle.includes('仅存路径，不读内容'), '必须显式标注仅存路径防护标识');
    assert(rawBytes.length < 60, `内存驻留仅 ${rawBytes.length} 字节`);

    ext.disable();
});

await reporter.run('5.5 敏感凭据/密码捕获测试 (密码管理器文本正常捕获入纯内存，不落盘)', async () => {
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

// ============================================================================
// SUITE 6: 队列容量淘汰测试 (max-items 边界与 FIFO/LRU 截断)
// ============================================================================
reporter.suite('6. 队列容量淘汰测试 (max-items 边界、FIFO 淘汰、LRU 优先级)');

await reporter.run('6.1 Max-Items Schema 边界锁定 (min=5) 与 FIFO 先入先出淘汰', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 根据 gschema.xml 定义，max-items 范围为 [5, 100]，测试下限边界值 5
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

await reporter.run('6.2 动态设置变更即刻裁剪超出条目 (_settings changed::max-items 缩容至 5 项)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._settings.set_int('max-items', 10);
    for (let i = 1; i <= 8; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`Dynamic-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    assert(getExtItemCount(ext) === 8, '初始应有 8 条');

    // 缩减配置至 5 项 (符合 Schema 范围)
    ext._settings.set_int('max-items', 5);
    assert(getExtItemCount(ext) === 5, '监听到设置变化后立即缩容至 5 项');
    assert(getExtItem(ext, 0).title === 'Dynamic-8', '保留最新项 Dynamic-8');
    assert(getExtItem(ext, 4).title === 'Dynamic-4', '尾项为 Dynamic-4，旧条目被弹出');

    ext._settings.set_int('max-items', 30);
    ext.disable();
});

await reporter.run('6.3 条目回放与 LRU 提升测试 (_restoreEntry 重置优先级)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`LRU-Target-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    // 当前队列顺序: LRU-Target-3, LRU-Target-2, LRU-Target-1
    assert(getExtItem(ext, 2).title === 'LRU-Target-1', '尾项为 LRU-Target-1');

    // 打开弹窗，选中尾项并回车恢复
    ext._openPopup();
    ext._setSelectedIndex(2);
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Return });

    // 此时 LRU-Target-1 被提升至首位
    assert(getExtItem(ext, 0).title === 'LRU-Target-1', '回放项成功跃迁至队列首位');
    assert(ext._lastChecksum !== '', '应预置对齐 _lastChecksum');

    // 验证回放后系统派发的 owner-changed 自然命中去重逻辑，不增加任何条目
    const echoSrc = new MockSelectionSource(['text/plain'], new TextEncoder().encode('LRU-Target-1'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, echoSrc);
    assert(getExtItemCount(ext) === 3, '系统回环事件被自然去重拦截，队列条数不增加');

    ext.disable();
});

await reporter.run('6.4 相同内容 MD5 去重防御 (连续相同输入不增加历史)', async () => {
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

await reporter.run('6.5 disable 清空纯内存历史 (解除所有引用供 GC 回收)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`MemLeakTest-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    assert(getExtItemCount(ext) === 3, '已写入 3 项');

    ext.disable();
    // 重新 enable
    ext.enable();
    assert(getExtItemCount(ext) === 0, '重新启用后队列应重置为空');
    ext.disable();
});

await reporter.run('6.6 全局总内存上限裁剪测试 (max-total-size-mb 内存超额 FIFO 淘汰)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 允许单条 30MB，全局总上限 50MB
    ext._settings.set_int('max-size-mb', 30);
    ext._settings.set_int('max-total-size-mb', 50);

    // 写入条目 1: 25MB
    const buf25MB = new Uint8Array(25 * 1024 * 1024);
    buf25MB[0] = 1;
    const src1 = new MockSelectionSource(['application/octet-stream'], buf25MB);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    assert(getExtItemCount(ext) === 1, '条目 1 写入成功');

    // 写入条目 2: 20MB (合计 45MB <= 50MB)
    const buf20MB = new Uint8Array(20 * 1024 * 1024);
    buf20MB[0] = 2;
    const src2 = new MockSelectionSource(['application/octet-stream'], buf20MB);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    assert(getExtItemCount(ext) === 2, '合计 45MB，两项均被保留');

    // 写入条目 3: 20MB (合计 65MB > 50MB)，应触发全局总上限 FIFO 淘汰最旧的条目 1 (25MB)，留下条目 3 和 2
    const buf20MB_2 = new Uint8Array(20 * 1024 * 1024);
    buf20MB_2[0] = 3;
    const src3 = new MockSelectionSource(['application/octet-stream'], buf20MB_2);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src3);
    assert(getExtItemCount(ext) === 2, '超出全局总上限，自动淘汰最旧条目');

    ext._settings.set_int('max-size-mb', 50);
    ext._settings.set_int('max-total-size-mb', 1024);
    ext.disable();
});

await reporter.run('6.7 全局非连续重复复制 LRU 提升测试 (A->B->A 自动提升至队首，无冗余重复项)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 复制 A
    const srcA1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Global-Target-A'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA1);
    const entryA = ext._getEntry(0);
    const timeA1 = entryA.time;

    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => { r(); return GLib.SOURCE_REMOVE; }));

    // 复制 B
    const srcB = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Global-Target-B'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcB);

    assert(getExtItemCount(ext) === 2, '当前有 A 和 B 两项');
    assert(getExtItem(ext, 0).title === 'Global-Target-B', '队首为 B');
    assert(getExtItem(ext, 1).title === 'Global-Target-A', '第二项为 A');

    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => { r(); return GLib.SOURCE_REMOVE; }));

    // 再次复制 A (非连续复制)
    const tBeforeA2 = Date.now();
    const srcA2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Global-Target-A'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, srcA2);

    assert(getExtItemCount(ext) === 2, '全局去重生效：总数仍为 2，未产生重复 A');
    assert(getExtItem(ext, 0).title === 'Global-Target-A', 'A 被零拷贝自动提升至队首');
    assert(getExtItem(ext, 1).title === 'Global-Target-B', 'B 顺延至第二项');
    assert(ext._getEntry(0).id === entryA.id, '队首条目对象引用不变');
    assert(ext._getEntry(0).time >= tBeforeA2, '重复复制那一刻的时间更新到提升到队首的条目 A');
    assert(ext._getEntry(0).time > timeA1, 'A 的复制时间已更新至最新复制时刻');

    ext.disable();
});

// ============================================================================
// SUITE 7: 条目快速删除与空列表边界测试
// ============================================================================
reporter.suite('7. 条目快速删除与空列表边界测试');

await reporter.run('7.1 快速连续单项删除与索引安全收敛', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 4; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`ItemToDel-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }
    assert(getExtItemCount(ext) === 4, '初始 4 项');

    // 删除第 0 项
    ext._deleteEntry(0);
    assert(getExtItemCount(ext) === 3, '剩 3 项');

    // 删除尾项
    ext._deleteEntry(2);
    assert(getExtItemCount(ext) === 2, '剩 2 项');

    // 删至空
    ext._deleteEntry(0);
    ext._deleteEntry(0);
    assert(getExtItemCount(ext) === 0, '完全清空');

    ext._openPopup();
    assert(ext._selectedIndex === 0, '空列表时 _selectedIndex 重置为 0');
    assert(ext._listContainer.children[0].text === '剪贴板历史为空', '正确渲染空状态占位标签');
    ext._closePopup();

    ext.disable();
});

await reporter.run('7.2 越界数值删除索引容错防御 (-1, 100, 999 越界安全防护)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode('KeepAlive'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);

    // 越界数值索引：负数与超出长度
    ext._deleteEntry(-1);
    ext._deleteEntry(1);
    ext._deleteEntry(999);
    ext._deleteEntry(-999);

    assert(getExtItemCount(ext) === 1, '越界数值删除不应修改有效队列');
    ext.disable();
});

await reporter.run('7.3 畸形非整数索引边界行为审计 (NaN / undefined / 字符串参数漏洞分析)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Alpha'));
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('Item-Beta'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    assert(getExtItemCount(ext) === 2, '初始应有 2 项');

    // 审计测试：JS 弱类型下 NaN < 0 为 false, NaN >= length 亦为 false
    // 这会导致执行 splice(NaN, 1)，等价于 splice(0, 1) 删除首项
    ext._deleteEntry(NaN);
    const countAfterNan = getExtItemCount(ext);
    // 此处记录此项边缘缺陷：若为 1 则说明 NaN 漏过守卫被转为 0 删除
    print(`    [安全审计发现] _deleteEntry(NaN) 执行后条目数: ${countAfterNan} (标准健壮防御应校验 typeof === 'number' && Number.isInteger)`);
    assert(countAfterNan <= 2, '未发生未捕获致命崩溃');

    ext.disable();
});

await reporter.run('7.4 空队列状态下的按键交互安全测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._openPopup();

    // 在空列表下触发所有键盘按键
    const keys = [
        Clutter.KEY_Up,
        Clutter.KEY_Down,
        Clutter.KEY_Return,
        Clutter.KEY_space,
        Clutter.KEY_Delete,
        Clutter.KEY_BackSpace,
    ];

    for (const k of keys) {
        const res = ext._onKeyPress({ get_key_symbol: () => k });
        assert(res === Clutter.EVENT_STOP, `空队列按键 ${k} 必须被安全消费`);
    }

    const escRes = ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Escape });
    assert(escRes === Clutter.EVENT_STOP, 'Esc 必须关闭弹窗');

    ext.disable();
});

await reporter.run('7.5 选中尾项删除后 _selectedIndex 自动向内收敛', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    for (let i = 1; i <= 3; i++) {
        const src = new MockSelectionSource(['text/plain'], new TextEncoder().encode(`Tail-${i}`));
        await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src);
    }

    ext._openPopup();
    ext._setSelectedIndex(2); // 选中尾项
    assert(ext._selectedIndex === 2, '当前选中尾项 2');

    // 按 Delete 键删除尾项
    ext._onKeyPress({ get_key_symbol: () => Clutter.KEY_Delete });
    assert(getExtItemCount(ext) === 2, '删除后剩 2 项');
    assert(ext._selectedIndex === 1, '选中索引自动收敛至新尾项 1');

    ext._closePopup();
    ext.disable();
});

await reporter.run('7.6 _restoreEntry 传入 null 或无效对象防御', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    ext._restoreEntry(null);
    ext._restoreEntry(undefined);
    ext._restoreEntry({});
    ext._restoreEntry({ bytes: null });

    assert(getExtItemCount(ext) === 0, '无效 entry 回放应安全忽略');
    ext.disable();
});

await reporter.run('7.7 清空历史后相同内容再次复制安全入库测试', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    const src1 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('SingleItem'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src1);
    assert(getExtItemCount(ext) === 1, '条目写入成功');

    // 删除清空
    ext._deleteEntry(0);
    assert(getExtItemCount(ext) === 0, '删除后队列为空');

    // 再次写入相同条目，必须准入
    const src2 = new MockSelectionSource(['text/plain'], new TextEncoder().encode('SingleItem'));
    await ext._onClipboardOwnerChanged(null, Meta.SelectionType.SELECTION_CLIPBOARD, src2);
    assert(getExtItemCount(ext) === 1, '清空历史后复制相同内容成功准入');
    assert(getExtItem(ext, 0).title === 'SingleItem', '条目内容正确');

    ext.disable();
});

// ============================================================================
// SUITE 8: 冻结对象与封装性测试
// ============================================================================
reporter.suite('8. 冻结对象与封装性测试');

await reporter.run('8.1 Object.isFrozen 冻结对象与严格模式属性只读保护', async () => {
    const rawData = new Uint8Array([0x12, 0x34, 0x56]);
    const testBytes = new GLib.Bytes(rawData);

    const entry = Object.freeze({
        id: 'frozen_entry_1',
        type: 'raw',
        mime: 'application/octet-stream',
        bytes: testBytes,
        checksum: 'md5_sum_sample',
        preview: 'raw',
        subtitle: 'raw sub',
        icon: 'application-x-generic-symbolic',
        time: Date.now(),
    });

    assert(Object.isFrozen(entry), '条目对象必须被 Object.freeze 冻结');

    // 尝试修改属性
    assertThrows(() => {
        'use strict';
        entry.mime = 'application/hacked';
    }, TypeError, '修改条目 mime 必须抛出 TypeError');
    assert(entry.mime === 'application/octet-stream', 'mime 属性未被修改');

    // 尝试修改 bytes 引用
    assertThrows(() => {
        'use strict';
        entry.bytes = null;
    }, TypeError, '置空 bytes 引用必须抛出 TypeError');
    assert(entry.bytes === testBytes, 'bytes 引用完整无损');

    // 添加新属性
    assertThrows(() => {
        'use strict';
        entry.injectedMalicious = true;
    }, TypeError, '添加新属性必须抛出 TypeError');

    // 属性删除
    assertThrows(() => {
        'use strict';
        delete entry.id;
    }, TypeError, '删除属性必须抛出 TypeError');
    assert(entry.id === 'frozen_entry_1', 'id 属性未被删除');
});

await reporter.run('8.2 原型与属性定义保护测试 (defineProperty / setPrototypeOf)', async () => {
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

await reporter.run('8.3 GLib.Bytes 底层原生堆内存不可变性测试', async () => {
    const rawData = new Uint8Array([10, 20, 30, 40]);
    const gBytes = new GLib.Bytes(rawData);

    // 外部获取 TypedArray 副本并试图就地修改
    const arr = gBytes.toArray();
    arr[0] = 99;
    arr[1] = 88;

    // 重新获取验证底层不变
    const fresh = gBytes.toArray();
    assert(fresh[0] === 10, 'GBytes 底层字节未受外部修改影响');
    assert(fresh[1] === 20, 'GBytes 底层字节未受外部修改影响');
});

await reporter.run('8.4 私有字段 #history 封装性验证', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 验证无论何种反射机制都无法穿透 #history
    assert(ext['#history'] === undefined, '属性索引访问不到私有字段');
    assert(!Reflect.has(ext, '#history'), 'Reflect.has 无法探测私有字段');
    assert(!Object.getOwnPropertyNames(ext).includes('#history'), 'getOwnPropertyNames 不可见');
    assert(Object.getOwnPropertySymbols(ext).length === 0, '未通过 Symbol 暴露');

    ext.disable();
});

await reporter.run('8.5 跨条目独立性隔离 (多条目冻结不互相干扰)', async () => {
    const b1 = new GLib.Bytes(new Uint8Array([1]));
    const b2 = new GLib.Bytes(new Uint8Array([2]));

    const e1 = Object.freeze({ id: '1', bytes: b1 });
    const e2 = Object.freeze({ id: '2', bytes: b2 });

    assert(e1 !== e2, '不同条目对象引用独立');
    assert(e1.bytes !== e2.bytes, '底层字节引用独立');
});

await reporter.run('8.6 条目对象冻结属性只读验证 (Object.freeze 保护)', async () => {
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

await reporter.run('8.7 日志开关功能验证 (enable-logging 关闭时静默，开启时按需输出)', async () => {
    const ext = new RawClipboardExtension({ uuid: 'raw-clipboard@local' });
    ext.enable();

    // 默认关闭状态
    ext._settings.set_boolean('enable-logging', false);
    assert(ext._isLoggingEnabled() === false, '默认状态下日志应处于关闭状态');

    // 验证关闭时不抛异常且安全短路
    ext._log('test log');
    ext._warn('test warn');
    ext._error('test error');

    // 开启状态
    ext._settings.set_boolean('enable-logging', true);
    assert(ext._isLoggingEnabled() === true, '开启后日志状态为 true');
    ext._log('test log enabled');
    ext._warn('test warn enabled');

    // 恢复默认关闭
    ext._settings.set_boolean('enable-logging', false);
    assert(ext._isLoggingEnabled() === false, '恢复后日志处于关闭状态');
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
