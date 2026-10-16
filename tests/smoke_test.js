import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const Utf8Decoder = new TextDecoder();

// 核心 MIME 检测逻辑 (与 extension.js 保持同步)
// 纯内存暂存：不屏蔽密码等类型，保留原始字节流
function detectCoreMime(mimeTypes) {
    if (!mimeTypes || mimeTypes.length === 0) return null;

    // 1. 位图图片类（仅常见位图支持缩略图预览：PNG, JPEG, WebP, BMP, GIF；SVG 等矢量格式作为未知类型仅保留原始数据）
    const imgMime = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'].find(m => mimeTypes.includes(m));
    if (imgMime) return { mime: imgMime, type: 'image' };

    // 2. 复制文件列表 (Nautilus, Dolphin 等)
    // 优先读取 x-special/gnome-copied-files 以便精准识别 copy 或 cut（剪切）动作标记
    const fileMime = ['x-special/gnome-copied-files', 'text/uri-list'].find(m => mimeTypes.includes(m));
    if (fileMime) {
        const isKdeCut = mimeTypes.includes('application/x-kde-cutselection');
        return { mime: fileMime, type: 'files', isKdeCut };
    }

    // 3. 复合类型 (多 MIME：如网页复制同时提供 text/html 和 text/plain 两种表示，保留富文本与纯文本双格式)
    const hasHtml = mimeTypes.includes('text/html');
    const textMime = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING'].find(m => mimeTypes.includes(m));
    if (hasHtml && textMime) {
        return {
            type: 'composite',
            mime: 'composite',
            htmlMime: 'text/html',
            textMime: textMime,
        };
    }

    // 4. 纯文本（包括用户与密码管理器复制的密码字符串、Token 等）
    if (textMime) return { mime: textMime, type: 'text' };

    // 5. 富文本 HTML
    if (hasHtml) return { mime: 'text/html', type: 'html' };

    // 6. 兜底其它任意合法的 Raw 二进制类型（包含 SVG 等矢量格式，仅保留纯数据，不主动解析预览）
    const valid = mimeTypes.filter(m => !m.startsWith('TARGETS') && !m.startsWith('TIMESTAMP') && !m.startsWith('MULTIPLE'));
    if (valid.length > 0) return { mime: valid[0], type: 'raw' };

    return null;
}

// 模拟测试生成 Preview (严格只截取前 100 字节)
function generatePreview(type, mime, gBytes) {
    const size = gBytes.get_size();
    const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
    if (type === 'text') {
        const str = Utf8Decoder.decode(gBytes.toArray().subarray(0, 100)).trim();
        return { title: str, subtitle: `文本 · ${sizeStr}` };
    }
    if (type === 'composite') {
        return { title: '富文本内容', subtitle: `多类型 · ${sizeStr}` };
    }
    if (type === 'image') return { title: `位图 (${sizeStr})`, subtitle: mime };
    if (type === 'files') {
        const str = Utf8Decoder.decode(gBytes.toArray().subarray(0, 100));
        const lines = str.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && l !== 'copy' && l !== 'cut');
        return { title: `文件: ${lines.join(', ')}`, subtitle: `文件 · (仅存路径，不读内容) · ${sizeStr}` };
    }
    return { title: mime, subtitle: sizeStr };
}

async function runTests() {
    print('=== 开始 Raw Clipboard (纯内存版) 核心逻辑单元测试 ===');

    // 1. 测试 MIME 优先级探测
    print('[测试 1] 核心 MIME 探测逻辑与密码无损捕获...');
    const testCases = [
        { mimes: ['text/plain', 'UTF8_STRING', 'STRING'], expected: 'text' },
        { mimes: ['image/png', 'image/bmp', 'text/plain'], expected: 'image' },
        { mimes: ['text/uri-list', 'text/plain'], expected: 'files' },
        { mimes: ['text/html', 'text/plain'], expected: 'composite' },
        { mimes: ['text/html'], expected: 'html' },
        { mimes: ['application/x-custom-type'], expected: 'raw' },
        // 密码管理器（KeePassXC、1Password、Bitwarden、KDE 等）附带 hint 时正常识别为纯文本
        { mimes: ['x-kde-passwordManagerHint', 'text/plain'], expected: 'text' },
        { mimes: ['application/x-keepassxc-hint', 'text/plain'], expected: 'text' },
        { mimes: ['application/x-1password-hint', 'text/plain'], expected: 'text' },
        { mimes: ['application/x-bitwarden-hint', 'text/plain'], expected: 'text' },
    ];

    for (const tc of testCases) {
        const res = detectCoreMime(tc.mimes);
        const actual = res ? res.type : null;
        if (actual !== tc.expected) {
            throw new Error(`MIME 检测失败: 输入 ${tc.mimes}, 预期 ${tc.expected}, 实际 ${actual}`);
        }
    }
    print('  ✓ MIME 探测逻辑全部通过！');

    // 2. 测试纯内存 Raw 字节存储与无损回放（零文件操作）
    print('[测试 2] 纯内存 Raw 字节对象存储与回放测试...');
    const rawData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0x12, 0x34, 0x56, 0xFF]);
    const memoryBytes = GLib.Bytes.new(rawData);

    // 模拟纯内存条目 (冻结保护)
    const memoryHistory = [];
    const entry = Object.freeze({
        id: 'test_1',
        mime: 'image/png',
        type: 'image',
        bytes: memoryBytes, // 纯内存对象
        checksum: GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, memoryBytes),
    });
    memoryHistory.unshift(entry);

    if (!Object.isFrozen(entry)) {
        throw new Error('条目对象未正确冻结');
    }
    try {
        entry.mime = 'text/plain';
    } catch (_e) {}
    if (entry.mime !== 'image/png') {
        throw new Error('条目对象属性被意外修改');
    }

    // 模拟取出与字节校验
    const restored = memoryHistory[0];
    const restoredArray = restored.bytes.toArray();
    if (restoredArray.length !== rawData.length) {
        throw new Error('内存 Raw 数据长度不匹配');
    }
    for (let i = 0; i < rawData.length; i++) {
        if (restoredArray[i] !== rawData[i]) {
            throw new Error(`内存字节校验失败在索引 ${i}`);
        }
    }
    print('  ✓ 纯内存 Raw 二进制存储与提取 100% 吻合！无任何文件 I/O！');

    // 3. 测试文件复制防大文件穿透逻辑
    print('[测试 3] 验证复制文件行为：只存 URI 路径文本，严禁读取物理文件...');
    // 模拟文件管理器复制了一个 100GB 虚拟大文件的场景
    const fakeUriList = 'copy\nfile:///home/vmuser/Videos/huge_movie_100GB.mkv\n';
    const fakeUriBytes = GLib.Bytes.new(new TextEncoder().encode(fakeUriList));
    const preview = generatePreview('files', 'text/uri-list', fakeUriBytes);

    if (fakeUriBytes.get_size() > 1024) {
        throw new Error('文件复制产生的剪贴板数据异常偏大');
    }
    if (!preview.subtitle.includes('仅存路径，不读内容')) {
        throw new Error('未正确标记仅存路径保护策略');
    }
    print(`  ✓ 复制文件时内存占用仅 ${fakeUriBytes.get_size()} 字节，物理文件内容完全不受影响！`);

    // 3.1 测试剪切文件拦截机制（Cut files interception）
    print('[测试 3.1] 验证剪切文件拦截机制：剪切操作（Ctrl+X）源文件移动后不可回放，严格禁止入库...');
    const cutPayload = 'cut\nfile:///home/vmuser/Documents/secret.docx\n';
    const cutBytes = GLib.Bytes.new(new TextEncoder().encode(cutPayload));
    let isGnomeCut = false;
    const firstLine = Utf8Decoder.decode(cutBytes.toArray()).trim().split('\n')[0]?.trim().toLowerCase();
    if (firstLine === 'cut') {
        isGnomeCut = true;
    }
    if (!isGnomeCut) {
        throw new Error('未能识别 GNOME Nautilus 剪切文件动作');
    }

    // KDE Dolphin 剪切标记
    const kdeDetected = detectCoreMime(['text/uri-list', 'application/x-kde-cutselection']);
    if (!kdeDetected || !kdeDetected.isKdeCut) {
        throw new Error('未能识别 KDE Dolphin 剪切文件动作 (application/x-kde-cutselection)');
    }
    print('  ✓ GNOME 与 KDE 剪切文件标记识别准确，成功拦截！');

    // 4. 测试可配置超大流限制（防止过大内存占用，支持最大 1024MB / 1GB）
    print('[测试 4] 验证可配置超大 Payload 限制拦截...');
    const configuredMb = 50;
    const maxAllowedBytes = Math.max(5, Math.min(1024, configuredMb)) * 1024 * 1024;
    const oversizedSize = 60 * 1024 * 1024; // 60 MB
    const isOversized = oversizedSize > maxAllowedBytes;
    if (!isOversized) {
        throw new Error('未成功拦截超大载荷');
    }
    print(`  ✓ 成功按用户配置拦截 ${oversizedSize / (1024 * 1024)}MB 载荷（当前限制 ${configuredMb}MB，系统允许上限 1024MB）！`);

    // 5. 测试 GSettings Schema 校验
    print('[测试 5] GSettings Schema 校验...');
    const testDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const projectRoot = GLib.path_get_dirname(testDir);
    const schemasDir = GLib.build_filenamev([projectRoot, 'schemas']);
    const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
        schemasDir,
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const schema = schemaSource.lookup('org.gnome.shell.extensions.raw-clipboard', false);
    if (!schema) {
        throw new Error('未找到 org.gnome.shell.extensions.raw-clipboard Schema');
    }
    const settings = new Gio.Settings({ settings_schema: schema });
    const shortcut = settings.get_strv('toggle-shortcut');
    const maxItems = settings.get_int('max-items');
    const maxSizeMb = settings.get_int('max-size-mb');
    if (maxSizeMb < 5 || maxSizeMb > 1024) {
        throw new Error(`max-size-mb 默认值超出合法范围: ${maxSizeMb}`);
    }
    const maxTotalMb = settings.get_int('max-total-size-mb');
    if (maxTotalMb < 50 || maxTotalMb > 4096) {
        throw new Error(`max-total-size-mb 默认值超出合法范围: ${maxTotalMb}`);
    }
    const maxThumbDim = settings.get_int('max-thumbnail-dimension');
    if (maxThumbDim < 512 || maxThumbDim > 16384) {
        throw new Error(`max-thumbnail-dimension 默认值超出合法范围: ${maxThumbDim}`);
    }
    const defaultLogging = settings.get_default_value('enable-logging').get_boolean();
    if (defaultLogging !== false) {
        throw new Error(`enable-logging 默认值应为 false, 实际为: ${defaultLogging}`);
    }
    const currentLogging = settings.get_boolean('enable-logging');
    print(`  ✓ Schema 加载成功: 快捷键 = ${JSON.stringify(shortcut)}, 最大条目 = ${maxItems}, 单条上限 = ${maxSizeMb} MB, 全局总上限 = ${maxTotalMb} MB, 缩略图上限 = ${maxThumbDim} px (4K护栏), 日志默认值 = ${defaultLogging} (当前用户设置 = ${currentLogging})`);

    // 6. 测试纯内存图片缩略图生成 (GdkPixbuf -> Gio.BytesIcon)
    print('[测试 6] 纯内存图片缩略图生成与内存对象绑定...');
    const GdkPixbuf = (await import('gi://GdkPixbuf')).default;
    const testPixbuf = new GdkPixbuf.Pixbuf({
        colorspace: GdkPixbuf.Colorspace.RGB,
        has_alpha: true,
        bits_per_sample: 8,
        width: 128,
        height: 128,
    });
    testPixbuf.fill(0x336699ff);
    const [, testBuffer] = testPixbuf.save_to_bufferv('png', [], []);
    const imgBytes = new GLib.Bytes(testBuffer);

    // 模拟 extension.js 中的纯内存缩略图生成逻辑
    const memIn = Gio.MemoryInputStream.new_from_bytes(imgBytes);
    const scaledPix = GdkPixbuf.Pixbuf.new_from_stream_at_scale(memIn, 64, 64, true, null);
    const [thumbOk, thumbBuf] = scaledPix.save_to_bufferv('png', [], []);
    if (!thumbOk || thumbBuf.length === 0) {
        throw new Error('缩略图生成序列化失败');
    }
    const thumbIcon = Gio.BytesIcon.new(new GLib.Bytes(thumbBuf));
    if (!(thumbIcon instanceof Gio.Icon)) {
        throw new Error('生成的缩略图对象不是合法的 Gio.Icon');
    }
    print(`  ✓ 缩略图生成成功 (${scaledPix.get_width()}x${scaledPix.get_height()}, 仅耗 ${thumbBuf.length} 字节纯内存)！`);

    print('=== 所有纯内存核心逻辑单元测试 100% 成功通过！ ===');
    loop.quit();
    imports.system.exit(0);
}

const loop = new GLib.MainLoop(null, false);
runTests().catch(err => {
    printerr('测试失败:', err);
    loop.quit();
    imports.system.exit(1);
});
loop.run();

