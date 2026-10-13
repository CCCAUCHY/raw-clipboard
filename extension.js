import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * 契约级通用 GAsyncReadyCallback 异步调用工具函数
 * 严格遵从 C/GIR 标准异步契约 (method_async + method_finish)，不依赖内部私有 API (如 Gio._promisify)，
 * 绝不污染系统类原型，并同时无缝兼容 Promise mock 实现。
 */
function callAsync(target, asyncMethod, finishMethod, ...args) {
    return new Promise((resolve, reject) => {
        try {
            const ret = target[asyncMethod](...args, (source, res) => {
                try {
                    const finishFn = source ? source[finishMethod] : target[finishMethod];
                    if (typeof finishFn === 'function') {
                        resolve(finishFn.call(source || target, res));
                    } else {
                        resolve(res);
                    }
                } catch (err) {
                    reject(err);
                }
            });
            if (ret && typeof ret.then === 'function') {
                ret.then(resolve, reject);
            }
        } catch (e) {
            try {
                const ret = target[asyncMethod](...args);
                if (ret && typeof ret.then === 'function') {
                    ret.then(resolve, reject);
                } else {
                    reject(e);
                }
            } catch (_err) {
                reject(e);
            }
        }
    });
}

/**
 * 动画减弱偏好探测工具函数
 * 兼容不同 GNOME 版本下 St.Settings / St.ReducedMotion 接口差异
 */
function shouldUseMotion() {
    try {
        const settings = St.Settings.get();
        if (settings && St.ReducedMotion) {
            const val = settings.reduced_motion ?? settings.reducedMotion;
            return val !== St.ReducedMotion.REDUCE;
        }
    } catch (_e) {}
    return true;
}

// 格式化记录复制时间 (当天显示 HH:mm:ss，跨天显示 n天前 HH:mm)
export function formatTime(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') return '';
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const itemStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.max(0, Math.floor((todayStart - itemStart) / (24 * 60 * 60 * 1000)));

    if (diffDays === 0) {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    return `${diffDays}天前 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 提取键盘按键对应的可输入字符 (过滤控制键与修饰键)
export function getPrintableChar(event) {
    if (!event) return null;
    const symbol = typeof event.get_key_symbol === 'function' ? event.get_key_symbol() : 0;
    const state = typeof event.get_state === 'function' ? event.get_state() : 0;
    const isCtrl = Boolean(state & Clutter.ModifierType.CONTROL_MASK);
    const isAlt = Boolean(state & Clutter.ModifierType.MOD1_MASK);
    const isSuper = Boolean(state & Clutter.ModifierType.SUPER_MASK);
    if (isCtrl || isAlt || isSuper) return null;

    if (typeof event.get_key_unicode === 'function') {
        const u = event.get_key_unicode();
        if (u >= 32 && u !== 127) return String.fromCodePoint(u);
    }
    if (typeof Clutter.keysym_to_unicode === 'function') {
        const u = Clutter.keysym_to_unicode(symbol);
        if (u >= 32 && u !== 127) return String.fromCodePoint(u);
    }
    if (symbol >= 0x20 && symbol <= 0x7e) {
        return String.fromCharCode(symbol);
    }
    if (symbol >= 0x01000100 && symbol <= 0x0110ffff) {
        return String.fromCodePoint(symbol - 0x01000000);
    }
    return null;
}

const Utf8Decoder = new TextDecoder();

// 核心 MIME 检测规则
// 纯内存暂存：不屏蔽密码等类型，保留原始字节流
function detectCoreMime(mimeTypes) {
    if (!mimeTypes || mimeTypes.length === 0) return null;

    // 1. 位图图片类（仅常见位图支持缩略图预览；SVG 等矢量格式作为 raw 类型仅保留原始数据）
    const imgMime = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'].find(m => mimeTypes.includes(m));
    if (imgMime) {
        return { mime: imgMime, type: 'image' };
    }

    // 2. 文件列表 (Nautilus, Nemo, Dolphin 等)
    // 优先读取 x-special/gnome-copied-files 以便精准识别 copy 或 cut（剪切）动作标记
    const fileMime = ['x-special/gnome-copied-files', 'text/uri-list'].find(m => mimeTypes.includes(m));
    if (fileMime) {
        const isKdeCut = mimeTypes.includes('application/x-kde-cutselection');
        return { mime: fileMime, type: 'files', isKdeCut };
    }

    // 3. 纯文本（包括用户与密码管理器复制的密码字符串、Token 等）
    const textMime = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING'].find(m => mimeTypes.includes(m));
    if (textMime) {
        return { mime: textMime, type: 'text' };
    }

    // 4. 富文本 HTML
    if (mimeTypes.includes('text/html')) {
        return { mime: 'text/html', type: 'html' };
    }

    // 5. 兜底其它任意合法的 Raw 二进制类型（包含 SVG 等矢量格式，仅保留纯数据，不主动解析预览）
    const valid = mimeTypes.filter(m => !m.startsWith('TARGETS') && !m.startsWith('TIMESTAMP') && !m.startsWith('MULTIPLE'));
    if (valid.length > 0) {
        return { mime: valid[0], type: 'raw' };
    }

    return null;
}

// 根据类型和原始字节生成界面显示的简短摘要
// 关键设计准则：
// 1. 一个条目是否能预览，取决于能不能以文本形式显示；
// 2. 类型严格按照它自身，不能串味到其他类型；
// 3. 我们只维护有限的类型预览（文本、富文本、文件列表、位图）；
// 4. 其他未知类型只显示类型本身（mime），不显示预览；
// 5. 且只有位图能以缩略图形式预览。
function generatePreview(type, mime, gBytes, unknownTypeName = null) {
    const size = gBytes.get_size();
    const sizeStr = size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` :
                    size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;

    // 1. 文本类 (纯文本、富文本 HTML 等)：通过 Gio.MemoryInputStream 零拷贝流按需读取
    // 准则：只要能以文本形式显示，就提取前缀文本作为预览；若全是控制字符/乱码无法以文本形式显示，则只显示类型本身
    if (type === 'text' || type === 'html') {
        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
            const CHUNK_SIZE = 64 * 1024; // 64KB (65536 字节)：吞吐性价比极高，单次仅需零点几毫秒即可大跨步捕获深层文本
            let text = '';
            let clean = '';

            // 初次预览逻辑与递进式预览统一成一个最多执行 10 次的循环，遇到非空文本则跳出循环
            for (let attempt = 0; attempt < 10; attempt++) {
                const chunk = stream.read_bytes(CHUNK_SIZE, null);
                if (!chunk || chunk.get_size() === 0) break;
                text += Utf8Decoder.decode(chunk);
                clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
                if (clean) break;
            }

            // 能以文本形式显示：展示前 1000 字符预览（全空白文本安全显示为 (空文本)）
            return {
                title: clean.length > 1000 ? `${clean.slice(0, 1000)}…` : (clean || '(空文本)'),
                subtitle: `${type === 'html' ? '富文本' : '文本'} · ${sizeStr}`,
                icon: type === 'html' ? 'text-html-symbolic' : 'edit-copy-symbolic',
            };
        } catch (_e) {
            return {
                title: mime,
                subtitle: sizeStr,
                icon: type === 'html' ? 'text-html-symbolic' : 'edit-copy-symbolic',
            };
        }
    }

    // 2. 文件与目录列表 (按需流式读取前缀路径，以文本形式解析文件名列表进行预览)
    if (type === 'files') {
        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
            const chunk = stream.read_bytes(4096, null);
            const text = Utf8Decoder.decode(chunk);

            const lines = text.split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#') && l !== 'copy' && l !== 'cut');

            // 若无任何有效路径，优雅标识空文件列表
            if (lines.length === 0) {
                return {
                    title: '文件列表',
                    subtitle: '文件 · 0 项 (仅存路径，不读内容)',
                    icon: 'text-x-generic-symbolic',
                };
            }

            let totalCount = lines.length;
            let isCapped = false;
            if (gBytes.get_size() > 4096) {
                let next;
                let scannedBytes = 0;
                const MAX_SCAN_BYTES = 64 * 1024;
                const MAX_ITEMS_CAP = 500;
                while (totalCount < MAX_ITEMS_CAP && scannedBytes < MAX_SCAN_BYTES && (next = stream.read_bytes(16384, null)) && next.get_size() > 0) {
                    scannedBytes += next.get_size();
                    const d = next.get_data();
                    for (let i = 0; i < d.length; i++) {
                        if (d[i] === 10) {
                            totalCount++;
                            if (totalCount >= MAX_ITEMS_CAP) {
                                isCapped = true;
                                break;
                            }
                        }
                    }
                }
                if (scannedBytes >= MAX_SCAN_BYTES) {
                    isCapped = true;
                }
            }

            // URI 容错解码函数：遇非法 percent 编码（如 %zz）时降级保留原字符，避免抛出异常
            const safeDecode = (str) => {
                try {
                    return decodeURIComponent(str);
                } catch (_e) {
                    return str;
                }
            };

            const parseName = (uri) => {
                if (!uri || typeof uri !== 'string') return '';
                const isExplicitDir = uri.endsWith('/') || uri.endsWith('\\');
                const clean = isExplicitDir ? uri.slice(0, -1) : uri;
                const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
                const raw = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
                return safeDecode(raw || uri);
            };

            const name1 = parseName(lines[0]);
            const name2 = lines.length > 1 ? parseName(lines[1]) : null;

            let dirCount = 0;
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i];
                let isDir = l.endsWith('/') || l.endsWith('\\');
                if (!isDir && i === 0 && l.startsWith('file://')) {
                    try {
                        const clean = l.replace(/[/\\]+$/, '');
                        const [p] = GLib.filename_from_uri(clean);
                        if (p && GLib.file_test(p, GLib.FileTest.IS_DIR)) isDir = true;
                    } catch (_e) {}
                }
                if (isDir) dirCount++;
            }

            const isAllDir = dirCount === totalCount;
            const isMixed = dirCount > 0 && !isAllDir;
            const icon = dirCount > 0 ? 'folder-symbolic' : 'text-x-generic-symbolic';
            const label = isAllDir ? '文件夹' : (isMixed ? '文件/目录' : '文件');
            const countStr = isCapped ? `${totalCount}+` : `${totalCount}`;
            const suffix = isAllDir ? `等 ${countStr} 个文件夹` : (isMixed ? `等 ${countStr} 项` : `等 ${countStr} 个文件`);

            const title = totalCount === 1 ? name1 :
                          totalCount === 2 ? `${name1}, ${name2}` :
                          `${name1}, ${name2} ${suffix}`;

            return {
                title,
                subtitle: `${label} · ${countStr} 项 (仅存路径，不读内容)`,
                icon,
            };
        } catch (_e) {
            // 异常兜底：严格按照自身类型显示，绝不串味成 folder 图标
            return {
                title: `文件列表 (${sizeStr})`,
                subtitle: mime,
                icon: 'text-x-generic-symbolic',
            };
        }
    }

    // 3. 位图类 (严格仅限位图格式：不能以文本形式显示，不显示文本预览；且只有位图能以缩略图形式预览)
    if (type === 'image') {
        return {
            title: `图片 (${sizeStr})`,
            subtitle: mime,
            icon: 'image-x-generic-symbolic',
        };
    }

    // 4. 其余未知类型：严格不解析预览内容，仅显示未知类型编号与数据大小
    return {
        title: unknownTypeName || '未知类型',
        subtitle: sizeStr,
        icon: 'application-x-generic-symbolic',
    };
}

// 自发回灌回环标识 Symbol（用于 owner-changed 事件中识别本扩展自发设置的数据源）
export const RESTORE_NONCE = Symbol('raw-clipboard-restore-nonce');

// 剪贴板慢源读取超时阈值 (Guard Timeouts)
export const INACTIVITY_TIMEOUT_MS = 5000; // 0 字节停滞超时 (连续 5 秒无新数据到达则终止)
export const OVERALL_TIMEOUT_MS = 15000;   // 单次读取总体超时上限 (15 秒上限)

// ============================================================================
// 纯内存 Radix Raw 前缀树存储与查重内核 (Radix Raw History Engine)
// 1. 结构即查重：以 MIME 为根，纯 Raw 二进制字节为边，插入过程即为查重过程；
// 2. 空间共享：公共前缀节点切片共享，后缀分叉；
// 3. 动态修剪与合并：条目淘汰/删除时沿路径回溯剪枝，单分支自动收缩合并。
// ============================================================================

export function findLongestCommonPrefix(a, b, offA = 0, offB = 0) {
    const isBytesA = a && typeof a.get_size === 'function';
    const isBytesB = b && typeof b.get_size === 'function';
    const sA = isBytesA ? a.get_size() : a.length;
    const sB = isBytesB ? b.get_size() : b.length;
    const remA = Math.max(0, sA - offA);
    const remB = Math.max(0, sB - offB);
    const len = Math.min(remA, remB);
    if (len === 0) return 0;

    const uA = isBytesA ? a.get_data() : a;
    const uB = isBytesB ? b.get_data() : b;

    let i = 0;
    const byteOffA = (uA.byteOffset || 0) + offA;
    const byteOffB = (uB.byteOffset || 0) + offB;

    // 当且仅当两端均对齐到 4 字节边界（同余且为 4 的倍数）且待比对长度至少 4 字节时，利用 Uint32Array 视图进行 4 字节快速比较
    if (uA.buffer && uB.buffer && ((byteOffA | byteOffB) & 3) === 0 && len >= 4) {
        const wordLen = len >>> 2;
        const u32A = new Uint32Array(uA.buffer, byteOffA, wordLen);
        const u32B = new Uint32Array(uB.buffer, byteOffB, wordLen);
        let w = 0;
        while (w < wordLen) {
            if (u32A[w] !== u32B[w]) break;
            w++;
        }
        i = w << 2;
    }

    // 逐字节比对（处理未对齐情况、Uint32 差异单词内的精确定位，以及尾部剩余 1~3 字节）
    while (i < len) {
        if (uA[offA + i] !== uB[offB + i]) break;
        i++;
    }
    return i;
}

export function makeSliceBytes(sourceBytes, uData, offset, len) {
    if (offset === 0 && len === uData.length) {
        return sourceBytes;
    }
    // 分配独立缓冲区的 GLib.Bytes，仅占 len 字节，彻底解绑对母体 parent 缓冲区的强引用持有，
    // 根除 GLib.Bytes.new_from_bytes 导致大对象（如 50MB 图像）因几字节前缀切片而整块缓冲区无法被 GC 释放的问题
    return new GLib.Bytes(uData.slice(offset, offset + len));
}

export class RadixNode {
    constructor(bytes = null, parent = null) {
        this.bytes = bytes;
        this.parent = parent;
        this.children = new Map(); // byte (0-255) -> RadixNode
        this.entry = null;
        this._data = null;
    }

    get data() {
        if (!this._data && this.bytes) {
            this._data = this.bytes.get_data();
        }
        return this._data;
    }

    setBytes(bytes) {
        this.bytes = bytes;
        this._data = null;
    }

    collectPathSegments() {
        const segments = [];
        let curr = this;
        while (curr && curr.bytes) {
            segments.unshift(curr.bytes);
            curr = curr.parent;
        }
        return segments;
    }
}

export class RadixRawTree {
    #nodeByEntry = new WeakMap();

    constructor() {
        this._roots = new Map(); // mime -> RadixNode
    }

    _getRoot(mime) {
        if (!this._roots.has(mime)) {
            this._roots.set(mime, new RadixNode(null, null));
        }
        return this._roots.get(mime);
    }

    hasRoot(mime) {
        return this._roots.has(mime);
    }

    getRoot(mime) {
        return this._roots.get(mime) || null;
    }

    get rootCount() {
        return this._roots.size;
    }

    getNode(entry) {
        if (!entry) return null;
        return this.#nodeByEntry.get(entry) || entry._radixNode || null;
    }

    insert(mime, gBytes, entryBuilder) {
        const root = this._getRoot(mime);
        const totalLen = gBytes.get_size();
        const uIncoming = gBytes.get_data();
        let currNode = root;
        let offset = 0;

        while (true) {
            const remainingLen = totalLen - offset;
            if (remainingLen === 0) {
                if (currNode.entry) {
                    return { isDuplicate: true, existingEntry: currNode.entry };
                }
                const entry = entryBuilder(currNode);
                currNode.entry = entry;
                this.#nodeByEntry.set(entry, currNode);
                return { isDuplicate: false, newEntry: entry };
            }

            const firstByte = uIncoming[offset];
            if (!currNode.children.has(firstByte)) {
                const leafBytes = makeSliceBytes(gBytes, uIncoming, offset, remainingLen);
                const leaf = new RadixNode(leafBytes, currNode);
                const entry = entryBuilder(leaf);
                leaf.entry = entry;
                this.#nodeByEntry.set(entry, leaf);
                currNode.children.set(firstByte, leaf);
                return { isDuplicate: false, newEntry: entry };
            }

            const child = currNode.children.get(firstByte);
            const childData = child.data;
            const childLen = childData.length;
            const commonLen = findLongestCommonPrefix(uIncoming, childData, offset, 0);

            if (commonLen === childLen) {
                offset += commonLen;
                currNode = child;
                continue;
            }

            // 分裂子边为 [公共前缀] 与 [旧后缀]
            const prefixBytes = makeSliceBytes(child.bytes, childData, 0, commonLen);
            const oldSuffixBytes = makeSliceBytes(child.bytes, childData, commonLen, childLen - commonLen);

            const splitNode = new RadixNode(prefixBytes, currNode);
            currNode.children.set(firstByte, splitNode);

            child.setBytes(oldSuffixBytes);
            child.parent = splitNode;
            const oldSuffixFirstByte = child.data[0];
            splitNode.children.set(oldSuffixFirstByte, child);

            offset += commonLen;
            if (offset === totalLen) {
                const entry = entryBuilder(splitNode);
                splitNode.entry = entry;
                this.#nodeByEntry.set(entry, splitNode);
                return { isDuplicate: false, newEntry: entry };
            } else {
                const newSuffixBytes = makeSliceBytes(gBytes, uIncoming, offset, totalLen - offset);
                const newLeaf = new RadixNode(newSuffixBytes, splitNode);
                const entry = entryBuilder(newLeaf);
                newLeaf.entry = entry;
                this.#nodeByEntry.set(entry, newLeaf);
                splitNode.children.set(uIncoming[offset], newLeaf);
                return { isDuplicate: false, newEntry: entry };
            }
        }
    }

    remove(entry) {
        if (!entry) return;
        const node = this.#nodeByEntry.get(entry) || entry._radixNode;
        if (!node) return;
        this.#nodeByEntry.delete(entry);
        node.entry = null;

        let curr = node;
        while (curr && curr.parent && curr.children.size === 0 && !curr.entry) {
            const parent = curr.parent;
            const firstByte = curr.data[0];
            parent.children.delete(firstByte);

            // 若父节点不是根、无挂载条目且仅剩单个子节点，自动合并收缩
            if (parent.parent && parent.children.size === 1 && !parent.entry) {
                const [, onlyChild] = parent.children.entries().next().value;
                const out = Gio.MemoryOutputStream.new_resizable();
                out.write_bytes(parent.bytes, null);
                out.write_bytes(onlyChild.bytes, null);
                out.close(null);
                const mergedBytes = out.steal_as_bytes();

                onlyChild.setBytes(mergedBytes);
                onlyChild.parent = parent.parent;
                const parentFirstByte = parent.data[0];
                parent.parent.children.set(parentFirstByte, onlyChild);
            }
            curr = parent;
        }
    }

    clear() {
        this._roots.clear();
        this.#nodeByEntry = new WeakMap();
    }
}

export default class RawClipboardExtension extends Extension {
    // 采用 JS 私有字段封装内存历史队列
    #history = [];
    // 纯内存 Radix Raw 前缀树存储内核
    #radixTree = new RadixRawTree();
    // 弹窗会话期间软删除标记集合 (Set of entry)
    #deletedEntries = new Set();
    // 自发回灌回环标识集合（单次消费，用于过滤回灌触发的 owner-changed 事件）
    #activeNonces = new Set();
    // 未知类型按元数据 raw 格式映射表 (mime -> '未知类型N')
    #unknownTypes = new Map();
    // 当前在途异步读取专属 Cancellable（用于抢占中断旧源）
    _currentReadCancellable = null;
    // 撤销栈 (LIFO 记录软删除条目)
    _undoStack = [];

    _inSearchMode = false;
    _searchQuery = '';
    _searchBar = null;
    _searchEntry = null;

    get inSearchMode() {
        return this._inSearchMode;
    }

    get searchQuery() {
        return this._searchQuery;
    }

    _isTextPreviewable(entry) {
        if (!entry) return false;
        return entry.type === 'text' || entry.type === 'html' || entry.type === 'files';
    }

    _onSearchTextChanged() {
        if (!this._inSearchMode) return;
        const newText = this._searchEntry ? this._searchEntry.get_text() : '';
        if (this._searchQuery === newText) return;
        this._searchQuery = newText;
        this._currentPage = 0;
        this._selectedIndex = 0;
        this._renderPage();
        this._updatePageBadge();
    }

    _onSearchEntryKeyPress(event) {
        if (!this._inSearchMode) return Clutter.EVENT_PROPAGATE;

        const symbol = event.get_key_symbol();
        const state = typeof event.get_state === 'function' ? event.get_state() : 0;

        // 1. 快捷键关闭 (二次兜底)：若当前按键与设置的 toggle-shortcut 匹配，则关闭弹窗
        if (this._settings) {
            const shortcuts = this._settings.get_strv('toggle-shortcut');
            if (shortcuts && shortcuts.length > 0) {
                const relevantMods = state & (
                    Clutter.ModifierType.CONTROL_MASK |
                    Clutter.ModifierType.MOD1_MASK |
                    Clutter.ModifierType.SHIFT_MASK |
                    Clutter.ModifierType.SUPER_MASK
                );
                if (typeof Meta.accelerator_name === 'function') {
                    const accel = Meta.accelerator_name(relevantMods, symbol);
                    if (accel && shortcuts.some(s => s.toLowerCase() === accel.toLowerCase())) {
                        this._closePopup();
                        return Clutter.EVENT_STOP;
                    }
                }
            }
        }

        // 2. Esc: 退出搜索模式回到完整列表 (不关闭弹窗)
        if (symbol === Clutter.KEY_Escape) {
            this._exitSearchMode();
            return Clutter.EVENT_STOP;
        }

        // 3. Enter / KP_Enter: 确认恢复当前选中的条目并关闭弹窗
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            const currentEntries = this._getSortedEntries();
            const totalCount = currentEntries.length;
            const globalIndex = this._currentPage * 8 + this._selectedIndex;
            if (globalIndex >= 0 && globalIndex < totalCount) {
                this._restoreEntry(currentEntries[globalIndex]);
            }
            this._closePopup();
            return Clutter.EVENT_STOP;
        }

        // 4. 方向键 Up: 在搜索结果列表中选择上一项
        if (symbol === Clutter.KEY_Up) {
            const currentEntries = this._getSortedEntries();
            const totalCount = currentEntries.length;
            const totalPages = Math.max(1, Math.ceil(totalCount / 8));
            if (totalCount > 0) {
                if (this._selectedIndex > 0) {
                    this._setSelectedIndex(this._selectedIndex - 1);
                } else if (this._currentPage > 0) {
                    const prevPageCount = 8;
                    this._setPage(this._currentPage - 1, prevPageCount - 1);
                } else if (totalPages > 1) {
                    const lastPage = totalPages - 1;
                    const lastPageCount = totalCount - lastPage * 8;
                    this._setPage(lastPage, lastPageCount - 1);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // 5. 方向键 Down: 在搜索结果列表中选择下一项
        if (symbol === Clutter.KEY_Down) {
            const currentEntries = this._getSortedEntries();
            const totalCount = currentEntries.length;
            const totalPages = Math.max(1, Math.ceil(totalCount / 8));
            const startIndex = this._currentPage * 8;
            const pageCount = Math.max(0, Math.min(8, totalCount - startIndex));
            if (totalCount > 0) {
                if (this._selectedIndex < pageCount - 1) {
                    this._setSelectedIndex(this._selectedIndex + 1);
                } else if (this._currentPage < totalPages - 1) {
                    this._setPage(this._currentPage + 1, 0);
                } else if (totalPages > 1) {
                    this._setPage(0, 0);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // 6. PageUp: 翻至上一页 (循环翻页)
        if (symbol === Clutter.KEY_Page_Up) {
            const currentEntries = this._getSortedEntries();
            const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
            if (totalPages > 1) {
                const targetPage = (this._currentPage - 1 + totalPages) % totalPages;
                this._setPage(targetPage, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // 7. PageDown: 翻至下一页 (循环翻页)
        if (symbol === Clutter.KEY_Page_Down) {
            const currentEntries = this._getSortedEntries();
            const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
            if (totalPages > 1) {
                const targetPage = (this._currentPage + 1) % totalPages;
                this._setPage(targetPage, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // 其余按键（字符输入、输入法选词上屏、左右光标移动、Shift+方向键选中、Home/End、Ctrl+C/V/X/A、Delete/BackSpace 等）
        // 一律放行给 ClutterText 原生处理！
        return Clutter.EVENT_PROPAGATE;
    }

    _enterSearchMode(initialChar = '') {
        this._inSearchMode = true;
        this._searchQuery = initialChar;
        if (this._sortBar) this._sortBar.hide();
        if (this._searchBar) this._searchBar.show();
        if (this._searchEntry) {
            this._searchEntry.set_text(this._searchQuery);
            if (this._searchEntry.clutter_text) {
                this._searchEntry.clutter_text.set_cursor_position(-1);
            }
            this._searchEntry.grab_key_focus();
        }
        this._currentPage = 0;
        this._selectedIndex = 0;
        this._renderPage();
        this._updatePageBadge();
    }

    _exitSearchMode() {
        if (!this._inSearchMode) return;
        this._inSearchMode = false;
        this._searchQuery = '';
        if (this._searchEntry) {
            this._searchEntry.set_text('');
        }
        if (this._searchBar) this._searchBar.hide();
        if (this._sortBar) this._sortBar.show();
        if (this._container) {
            this._container.grab_key_focus();
        }
        this._currentPage = 0;
        this._selectedIndex = 0;
        this._renderPage();
        this._updatePageBadge();
    }

    _getVisibleEntries() {
        if (this.#deletedEntries.size === 0) {
            return this.#history;
        }
        return this.#history.filter(e => !this.#deletedEntries.has(e));
    }

    _sortMode = 'queue'; // 'queue' | 'size' | 'type' | 'initial'

    get sortMode() {
        return this._sortMode;
    }

    _getSortedEntries() {
        if (this._inSearchMode) {
            // 搜索模式：字符删光时不退出搜索状态，但显示无匹配项目 (空结果)
            const query = (this._searchQuery || '').trim().toLowerCase();
            if (query.length === 0) {
                return [];
            }
            // 只匹配能以文本形式预览的项目，且只匹配预览内容；结果以记录顺序 (FIFO/LRU) 排序
            const visible = this._getVisibleEntries();
            return visible.filter(entry => {
                if (!this._isTextPreviewable(entry)) return false;
                const preview = (entry.preview || '').toLowerCase();
                return preview.includes(query);
            });
        }

        const visible = this._getVisibleEntries();
        if (this._sortMode === 'queue' || visible.length <= 1) {
            return visible;
        }

        const orderMap = new Map();
        visible.forEach((entry, idx) => orderMap.set(entry, idx));
        const copy = [...visible];

        if (this._sortMode === 'size') {
            copy.sort((a, b) => {
                const sizeA = typeof a.size === 'number' ? a.size : (a.bytes ? a.bytes.get_size() : 0);
                const sizeB = typeof b.size === 'number' ? b.size : (b.bytes ? b.bytes.get_size() : 0);
                if (sizeB !== sizeA) {
                    return sizeB - sizeA;
                }
                return orderMap.get(a) - orderMap.get(b);
            });
        } else if (this._sortMode === 'type') {
            const typeRank = { 'text': 1, 'html': 2, 'files': 3, 'image': 4, 'raw': 5 };
            copy.sort((a, b) => {
                const rankA = typeRank[a.type] || 99;
                const rankB = typeRank[b.type] || 99;
                if (rankA !== rankB) {
                    return rankA - rankB;
                }
                return orderMap.get(a) - orderMap.get(b);
            });
        } else if (this._sortMode === 'initial') {
            const getInitial = (str) => {
                if (!str || typeof str !== 'string') return null;
                const trimmed = str.trim();
                if (trimmed.length === 0) return null;
                const c = trimmed[0];
                if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
                    return c.toUpperCase();
                }
                return null;
            };

            copy.sort((a, b) => {
                const initA = getInitial(a.preview);
                const initB = getInitial(b.preview);

                const isEngA = initA !== null;
                const isEngB = initB !== null;

                if (isEngA && isEngB) {
                    if (initA !== initB) {
                        return initA.localeCompare(initB);
                    }
                    const cmp = a.preview.localeCompare(b.preview, 'en', { sensitivity: 'base' });
                    if (cmp !== 0) return cmp;
                    return orderMap.get(a) - orderMap.get(b);
                } else if (isEngA && !isEngB) {
                    return -1; // 英文排在前面
                } else if (!isEngA && isEngB) {
                    return 1;  // 其他语言排在英文后面
                } else {
                    // 其他语言排在英文后面按记录顺序排序
                    return orderMap.get(a) - orderMap.get(b);
                }
            });
        }

        return copy;
    }

    _setSortMode(mode) {
        if (this._sortMode === mode) return;
        this._sortMode = mode;
        if (this._sortButtons) {
            this._sortButtons.forEach((btn, id) => {
                if (id === mode) {
                    btn.add_style_class_name('active');
                } else {
                    btn.remove_style_class_name('active');
                }
            });
        }
        this._currentPage = 0;
        this._selectedIndex = 0;
        if (this._popup && this._popup.visible) {
            this._renderPage();
            this._updatePageBadge();
        }
    }

    _isLoggingEnabled() {
        return this._settings ? this._settings.get_boolean('enable-logging') : false;
    }

    _formatLogArgs(args) {
        if (args.length === 0) return ['[RawClipboard]'];
        const first = args[0];
        if (typeof first === 'string') {
            if (first.startsWith('[RawClipboard]')) {
                return args;
            }
            return [`[RawClipboard] ${first}`, ...args.slice(1)];
        }
        return ['[RawClipboard]', ...args];
    }

    _log(...args) {
        if (this._isLoggingEnabled()) {
            console.log(...this._formatLogArgs(args));
        }
    }

    _debug(...args) {
        this._log(...args);
    }

    _warn(...args) {
        this._log(...args);
    }

    _error(...args) {
        this._log(...args);
    }

    _formatEntryLog(entry) {
        if (!entry) return '[空条目]';
        const id = entry.id || 'unknown';
        const type = entry.type || 'unknown';
        const size = typeof entry.size === 'number' ? entry.size : (entry.bytes?.get_size ? entry.bytes.get_size() : 0);
        let md5 = 'none';
        try {
            if (entry.checksum) {
                md5 = String(entry.checksum).slice(0, 8);
            }
        } catch (_e) {}
        return `[条目#${id} (MD5:${md5}, ${type}, ${size}B)]`;
    }

    // 队首条目 (#history[0]) 即为最后一次入库、回灌或提升的内容，通过 getter 动态派生，
    // 避免独立维护冗余状态导致与队列状态不一致
    get _lastChecksum() {
        return this.#history.length > 0 ? this.#history[0].checksum : '';
    }

    get _lastHeadMd5() {
        return this.#history.length > 0 ? (this.#history[0].headMd5 || '') : '';
    }

    get _lastSize() {
        return this.#history.length > 0 ? (this.#history[0].size || 0) : 0;
    }

    get _radixTree() {
        return this.#radixTree;
    }

    _getUnknownTypeName(mime) {
        const key = mime || 'unknown';
        if (!this.#unknownTypes.has(key)) {
            const nextIdx = this.#unknownTypes.size + 1;
            this.#unknownTypes.set(key, `未知类型${nextIdx}`);
        }
        return this.#unknownTypes.get(key);
    }

    get unknownTypes() {
        return new Map(this.#unknownTypes);
    }

    _getEntry(index) {
        return this.#history[index] || null;
    }

    _getRadixNode(entry) {
        return this.#radixTree ? this.#radixTree.getNode(entry) : null;
    }

    enable() {
        this._settings = this.getSettings();
        this.#history = [];
        this.#radixTree = new RadixRawTree();
        this.#deletedEntries.clear();
        this.#unknownTypes.clear();
        this._undoStack = [];
        this._currentReadCancellable = null;
        this._selectionOwnerId = -1;
        this._cancellable = new Gio.Cancellable();
        this._renderIdleId = 0;
        this._grab = null;
        this._container = null;
        this._popup = null;
        this._sortBar = null;
        this._sortButtons = null;
        this._emptyLabel = null;
        this._listContainer = null;
        this._pageBar = null;
        this._pageBadge = null;
        this._itemSlots = null;
        this._itemActors = null;
        this._isClosing = false;
        this._selectedIndex = 0;
        this._currentPage = 0;
        this._sortMode = 'queue';
        this._hasKeybinding = false;
        this.#activeNonces.clear();
        this._isRestoring = false;

        this._settingsChangedId = -1;
        this._maxSizeChangedId = -1;
        this._totalSizeChangedId = -1;
        this._shortcutChangedId = -1;

        // 监听系统剪贴板变化
        this._selection = global.display.get_selection();
        this._selectionOwnerId = this._selection.connect(
            'owner-changed',
            this._onClipboardOwnerChanged.bind(this)
        );

        // 监听设置变化（动态裁剪超出上限的内存条目、单项容量与总容量）
        this._settingsChangedId = this._settings.connect(
            'changed::max-items',
            this._enforceLimit.bind(this)
        );

        this._maxSizeChangedId = this._settings.connect(
            'changed::max-size-mb',
            this._enforceLimit.bind(this)
        );

        this._totalSizeChangedId = this._settings.connect(
            'changed::max-total-size-mb',
            this._enforceLimit.bind(this)
        );

        // 监听快捷键修改事件，实现即时生效
        this._shortcutChangedId = this._settings.connect(
            'changed::toggle-shortcut',
            this._bindShortcut.bind(this)
        );

        // 监听系统锁屏状态：锁屏时若弹窗处于打开状态则安全关闭，避免焦点争抢
        if (Main.sessionMode) {
            this._sessionUpdatedId = Main.sessionMode.connect('updated', () => {
                if (Main.sessionMode.isLocked && this._container) {
                    this._closePopup();
                }
            });
        }

        // 注册全局快捷键
        this._bindShortcut();
        this._log('[RawClipboard] 扩展已启用');
        if (this._settings) {
            this._debug(`[RawClipboard] 初始配置: max-items=${this._settings.get_int('max-items')}, max-size-mb=${this._settings.get_int('max-size-mb')}, max-total-size-mb=${this._settings.get_int('max-total-size-mb')}, max-thumbnail-dimension=${this._settings.get_int('max-thumbnail-dimension')}`);
        }
    }

    disable() {
        this._log('[RawClipboard] 扩展已禁用，清理监听与状态');
        // 1. 注销快捷键
        if (this._hasKeybinding) {
            Main.wm.removeKeybinding('toggle-shortcut');
            this._hasKeybinding = false;
        }

        // 2. 取消所有在途读取操作并关闭管道，防止后续写回历史队列
        if (this._currentReadCancellable) {
            this._currentReadCancellable.cancel();
            this._currentReadCancellable = null;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        // 3. 取消任何挂起的 UI idle 刷新
        if (this._renderIdleId) {
            GLib.source_remove(this._renderIdleId);
            this._renderIdleId = 0;
        }

        // 4. 断开设置监听
        if (this._settingsChangedId >= 0) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = -1;
        }

        if (this._maxSizeChangedId >= 0) {
            this._settings.disconnect(this._maxSizeChangedId);
            this._maxSizeChangedId = -1;
        }

        if (this._totalSizeChangedId >= 0) {
            this._settings.disconnect(this._totalSizeChangedId);
            this._totalSizeChangedId = -1;
        }

        if (this._shortcutChangedId >= 0) {
            this._settings.disconnect(this._shortcutChangedId);
            this._shortcutChangedId = -1;
        }

        if (this._sessionUpdatedId && Main.sessionMode) {
            Main.sessionMode.disconnect(this._sessionUpdatedId);
            this._sessionUpdatedId = 0;
        }

        // 5. 断开剪贴板监听
        if (this._selectionOwnerId >= 0) {
            this._selection.disconnect(this._selectionOwnerId);
            this._selectionOwnerId = -1;
        }

        // 6. 立即销毁弹窗（无需等待动画）
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._container) {
            Main.layoutManager.uiGroup.remove_child(this._container);
            this._container.destroy();
            this._container = null;
            this._popup = null;
            this._listContainer = null;
            this._pageBar = null;
            this._pageBadge = null;
            this._undoBtn = null;
        }
        this._itemActors = null;
        this._isClosing = false;
        this.#deletedEntries.clear();
        this._undoStack = [];

        // 7. 清空纯内存历史列表与 Radix 前缀树（引用归零，GC 自动回收全部堆内存）
        this.#history = [];
        this.#radixTree.clear();
        this.#unknownTypes.clear();
        this.#activeNonces.clear();
        this._isRestoring = false;
        this._settings = null;
    }

    _bindShortcut() {
        if (this._hasKeybinding) {
            Main.wm.removeKeybinding('toggle-shortcut');
            this._hasKeybinding = false;
        }
        if (!this._settings) return;
        const shortcuts = this._settings.get_strv('toggle-shortcut');
        if (!shortcuts || shortcuts.length === 0 || !shortcuts[0]) {
            return;
        }

        const flags = (Meta.KeyBindingFlags && typeof Meta.KeyBindingFlags.IGNORE_AUTOREPEAT === 'number')
            ? Meta.KeyBindingFlags.IGNORE_AUTOREPEAT
            : Meta.KeyBindingFlags.NONE;
        const normalMode = (Shell.ActionMode && typeof Shell.ActionMode.NORMAL === 'number') ? Shell.ActionMode.NORMAL : 1;
        const overviewMode = (Shell.ActionMode && typeof Shell.ActionMode.OVERVIEW === 'number') ? Shell.ActionMode.OVERVIEW : 2;
        const popupMode = (Shell.ActionMode && typeof Shell.ActionMode.POPUP === 'number') ? Shell.ActionMode.POPUP : 128;
        const modes = normalMode | overviewMode | popupMode;

        const action = Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            flags,
            modes,
            () => this._togglePopup()
        );
        this._hasKeybinding = (action !== 0 && (!Meta.KeyBindingAction || action !== Meta.KeyBindingAction.NONE));
    }

    _generateThumbnail(gBytes, mime, maxDim = 4096) {
        // 仅对常见光栅位图生成缩略图，SVG 等矢量格式保留原始数据而不解析缩略图
        const BITMAP_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
        if (!BITMAP_MIMES.includes(mime)) {
            return null;
        }

        let loader = null;
        try {
            loader = GdkPixbuf.PixbufLoader.new_with_mime_type(mime);
        } catch (_e) {
            return null;
        }

        const fileSize = gBytes.get_size();
        let exceeded = false;
        let sizePrepared = false;
        let origW = 0, origH = 0;
        let maxMemoryLimit = 0; // 根据元数据（面积、位深、通道）动态计算出的最大合理内存上限

        this._log(`[RawClipboard] 生成缩略图开始: MIME=${mime}, 输入数据大小=${fileSize} 字节, 尺寸上限=${maxDim}px`);

        loader.connect('size-prepared', (l, w, h) => {
            sizePrepared = true;
            origW = w;
            origH = h;
            this._log(`[RawClipboard] 缩略图已解析出原图尺寸: ${w}x${h}`);
            // 基础长宽有效性及用户可配置的缩略图尺寸上限守卫 (max-thumbnail-dimension, 默认 4096)
            if (w <= 0 || h <= 0 || w > maxDim || h > maxDim || (w * h) > maxDim * maxDim) {
                this._log(`[RawClipboard] 原图尺寸 ${w}x${h} 超出预览尺寸限制 (${maxDim}px)，终止缩略图生成`);
                exceeded = true;
                l.set_size(1, 1);
                return;
            }

            // 仅对超过 64 像素的图片进行等比例下采样缩小，不超过 64 的保持原图尺寸，严禁过度放大
            if (w > 64 || h > 64) {
                let destW = 64, destH = 64;
                if (w > h) {
                    destH = Math.max(1, Math.round((h * 64) / w));
                } else {
                    destW = Math.max(1, Math.round((w * 64) / h));
                }
                l.set_size(destW, destH);
            }
        });

        loader.connect('area-prepared', (l) => {
            const pix = l.get_pixbuf();
            if (pix) {
                // 读取解码器返回的真实元数据（通道数与位深），兼容 1/3/4 通道及 Float32 (16字节) 等深色格式
                const channels = pix.get_n_channels ? pix.get_n_channels() : 4;
                const bitsPerSample = pix.get_bits_per_sample ? pix.get_bits_per_sample() : 8;
                const bytesPerSample = Math.ceil(bitsPerSample / 8);
                const bytesPerPixel = channels * bytesPerSample;

                // 根据返回的真实元数据（面积、位深、通道），统一计算该图片最大合理内存上限
                maxMemoryLimit = origW * origH * bytesPerPixel;
                this._log(`[RawClipboard] 缩略图元数据就绪: 通道数=${channels}, 位深=${bitsPerSample}, 计算合理内存上限=${maxMemoryLimit} 字节`);

                // 1. 对输入数据总量的统一裁决：若输入数据总量超过最大合理内存上限（加 1MB 容器头与专业级元数据冗余容差），直接终止并不预览
                const CONTAINER_HEADER_MARGIN = 1024 * 1024;
                if (fileSize > (maxMemoryLimit + CONTAINER_HEADER_MARGIN)) {
                    this._log(`[RawClipboard] 输入数据总量 ${fileSize} 字节超过最大合理内存上限 (${maxMemoryLimit} + 1MB)，终止缩略图生成`);
                    exceeded = true;
                    return;
                }

                // 2. 对后续解码使用内存的统一裁决：复核实际解码出的 pixbuf 缓冲区字节大小
                const byteLen = pix.get_byte_length ? pix.get_byte_length() : 0;
                const rowstride = pix.get_rowstride ? pix.get_rowstride() : (pix.get_width() * bytesPerPixel);
                const actualLimit = rowstride * pix.get_height();
                if (byteLen > actualLimit) {
                    this._log(`[RawClipboard] 缩略图缓冲区大小 ${byteLen} 字节超过预期上限 ${actualLimit} 字节，终止缩略图生成`);
                    exceeded = true;
                }
            }
        });

        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
            const CHUNK_SIZE = 64 * 1024;
            let totalFedBytes = 0;
            // 格式容器头冗余容差（如专业级大图包含的 EXIF, XMP, ICC Profile 等复杂元数据，最多 1MB）
            const CONTAINER_HEADER_MARGIN = 1024 * 1024;

            while (true) {
                if (exceeded) break; // 尺寸或解码炸弹超限时提前终止流式读取，避免不必要的解码
                const chunk = stream.read_bytes(CHUNK_SIZE, null);
                if (!chunk || chunk.get_size() === 0) break;

                totalFedBytes += chunk.get_size();

                // 对后续流式输入数据的统一裁决：向解码器投递的数据总量突破最大合理内存上限，直接终止并不预览
                if (sizePrepared && maxMemoryLimit > 0 && totalFedBytes > (maxMemoryLimit + CONTAINER_HEADER_MARGIN)) {
                    this._log(`[RawClipboard] 流式泵入字节数 ${totalFedBytes} 突破上限 (${maxMemoryLimit} + 1MB)，截断输入流`);
                    exceeded = true;
                    break;
                }

                loader.write_bytes(chunk);
            }
        } catch (_e) {}

        try {
            loader.close();
        } catch (_e) {}

        if (exceeded || !sizePrepared) {
            return null;
        }

        try {
            const pixbuf = loader.get_pixbuf();
            if (!pixbuf) return null;
            const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
            if (!ok) return null;
            this._log(`[RawClipboard] 缩略图生成成功，PNG 缓冲大小: ${buffer.length} 字节`);
            return Gio.BytesIcon.new(new GLib.Bytes(buffer));
        } catch (e) {
            this._log('[RawClipboard] Thumbnail generation failed:', e.message);
            return null;
        }
    }

    _queueRender() {
        if (this._renderIdleId) return;
        this._renderIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderIdleId = 0;
            if (this._popup && this._popup.visible) {
                this._renderPage();
                this._updatePageBadge();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    async _onClipboardOwnerChanged(_selection, selectionType, selectionSource) {
        if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
        const copyTime = Date.now();
        this._debug(`[RawClipboard] 收到剪贴板所有者变更通知 (SelectionType: ${selectionType})`);
        if (!this._cancellable || this._cancellable.is_cancelled()) return;

        // -------------------------------------------------------------
        // 读取守卫三重护栏机制 (Triple Guard for Stream Reads):
        // 守卫 1: 0 字节停滞超时 (连续 5 秒完全无新数据到达熔断)
        // 守卫 2: 总体硬超时上限 (单次抓取总耗时达 15 秒硬上限熔断)
        // 守卫 3: 抢占式守卫：读取过程中发生新的 owner-changed，立即中止并丢弃旧源
        // -------------------------------------------------------------

        // 守卫 3 前置生效：只要发生新的 owner-changed（无论新源是任何应用、剪贴板清空还是自研回灌），
        // 前序正在拉取的慢源已经彻底过时，立即下发取消信号掐断其管道，防止半截数据入库与并发紊乱
        if (this._currentReadCancellable && !this._currentReadCancellable.is_cancelled()) {
            this._log('[RawClipboard] 剪贴板所有者已易手 (触发新 owner-changed)，在途旧源读取立即中止并丢弃');
            this._currentReadCancellable.cancel();
            this._currentReadCancellable = null;
        }

        if (!selectionSource) {
            this._debug('[RawClipboard] 剪贴板源为空 (selectionSource 为 null)，跳过读取');
            return;
        }

        // 自发回灌回环识别：
        // 回灌写回剪贴板时会触发 owner-changed。通过匹配挂载在 source 上的一次性标识确认是否为本扩展自发写入，
        // 匹配后即刻移除。若匹配成功则跳过重复读取；即使未命中，也仅等价于一次常规的用户重复复制。
        const sourceNonce = selectionSource ? selectionSource[RESTORE_NONCE] : null;
        if (sourceNonce && this.#activeNonces.has(sourceNonce)) {
            this.#activeNonces.delete(sourceNonce);
            this._debug('[RawClipboard] 捕获到自发回灌的剪贴板源，跳过重复读取');
            return;
        }

        if (this._isRestoring) {
            this._debug('[RawClipboard] 命中同步回灌调用栈守卫，跳过捕获');
            return;
        }

        // 建立本次在途读取专属 Cancellable，并级联绑定实例级 Cancellable
        const readCancellable = new Gio.Cancellable();
        this._currentReadCancellable = readCancellable;

        let parentCancelId = 0;
        let watchdogId = 0;
        let overallTimeoutId = 0;
        let overallSettingsChangedId = 0;
        let inputStream = null;
        let outputStream = null;
        const overallStartTime = Date.now();

        try {
            if (this._cancellable) {
                parentCancelId = this._cancellable.connect(() => {
                    readCancellable.cancel();
                });
            }

            let inactivityTimeoutMs = INACTIVITY_TIMEOUT_MS;
            let overallTimeoutMs = OVERALL_TIMEOUT_MS;

            if (this._settings) {
                try {
                    const schema = this._settings.settings_schema;
                    if (!schema || schema.has_key('inactivity-timeout-sec')) {
                        const sec = this._settings.get_int('inactivity-timeout-sec');
                        if (sec > 0) inactivityTimeoutMs = sec * 1000;
                    }
                } catch (_) {}
                try {
                    const schema = this._settings.settings_schema;
                    if (!schema || schema.has_key('overall-timeout-sec')) {
                        const sec = this._settings.get_int('overall-timeout-sec');
                        if (sec > 0) overallTimeoutMs = sec * 1000;
                    }
                } catch (_) {}
            }

            if (this._inactivityTimeoutMs !== undefined) {
                inactivityTimeoutMs = this._inactivityTimeoutMs;
            }
            if (this._overallTimeoutMs !== undefined) {
                overallTimeoutMs = this._overallTimeoutMs;
            }

            // 守卫 1: 0 字节停滞看门狗 (连续指定毫秒无数据到达则超时熔断)
            const resetWatchdog = () => {
                if (watchdogId > 0) {
                    GLib.source_remove(watchdogId);
                    watchdogId = 0;
                }
                watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, inactivityTimeoutMs, () => {
                    watchdogId = 0;
                    this._warn(`[RawClipboard] 触发 0 字节停滞超时 (连续 ${inactivityTimeoutMs}ms 无数据到达)，中止并丢弃当前读取`);
                    readCancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });
            };
            resetWatchdog();

            // 守卫 2: 总体硬超时上限 (单次抓取总耗时达硬上限则超时熔断)
            // 且支持动态修改配置：修改此配置后，若当前已用传输时间超出此限制，则自动取消本次传输
            const scheduleOverallTimeout = (timeoutMs) => {
                if (overallTimeoutId > 0) {
                    GLib.source_remove(overallTimeoutId);
                    overallTimeoutId = 0;
                }
                const elapsedMs = Date.now() - overallStartTime;
                if (elapsedMs >= timeoutMs) {
                    this._warn(`[RawClipboard] 总体传输超时生效：当前已用时间 (${elapsedMs}ms) 已超出限制 (${timeoutMs}ms)，立即取消当前读取`);
                    readCancellable.cancel();
                    return;
                }
                const remainingMs = timeoutMs - elapsedMs;
                overallTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, remainingMs, () => {
                    overallTimeoutId = 0;
                    this._warn(`[RawClipboard] 触发单次抓取总体硬超时 (达 ${timeoutMs}ms 上限)，中止并丢弃当前读取`);
                    readCancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });
            };

            scheduleOverallTimeout(overallTimeoutMs);

            if (this._settings) {
                try {
                    overallSettingsChangedId = this._settings.connect('changed::overall-timeout-sec', () => {
                        try {
                            const sec = this._settings.get_int('overall-timeout-sec');
                            if (sec > 0) {
                                scheduleOverallTimeout(sec * 1000);
                            }
                        } catch (_) {}
                    });
                } catch (_) {}
            }
            const mimeTypes = selectionSource.get_mimetypes ? selectionSource.get_mimetypes() : [];
            this._debug('[RawClipboard] 剪贴板源提供 MIME 格式列表:', JSON.stringify(mimeTypes));
            const core = detectCoreMime(mimeTypes);
            if (!core) {
                this._debug('[RawClipboard] 未匹配到受支持的核心 MIME 类型，忽略当前剪贴板内容');
                return;
            }
            this._debug(`[RawClipboard] 匹配核心目标类型: ${core.mime} (归类: ${core.type})`);

            // 动态读取单条数据上限（MB），支持从 5MB 到 1024MB（最大 1GB）
            const maxMb = this._settings ? this._settings.get_int('max-size-mb') : 50;
            const maxPayloadBytes = Math.max(5, Math.min(1024, maxMb)) * 1024 * 1024;

            // 分块流式异步读取：
            // 每次拉取 64KB，在读循环中仅执行纯流式泵入，彻底消除 toArray() 深拷贝与逐块 FFI 计算开销
            this._debug(`[RawClipboard] 开始异步拉取数据流 (${core.mime}, 单条上限: ${maxMb}MB, 停滞超时: ${inactivityTimeoutMs}ms, 总超时: ${overallTimeoutMs}ms)...`);
            inputStream = await callAsync(selectionSource, 'read_async', 'read_finish', core.mime, readCancellable);
            resetWatchdog();

            outputStream = Gio.MemoryOutputStream.new_resizable();
            const CHUNK_SIZE = 64 * 1024;
            let totalRead = 0;
            let isOversized = false;

            while (true) {
                if (readCancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) break;

                const bytes = await callAsync(inputStream, 'read_bytes_async', 'read_bytes_finish', CHUNK_SIZE, GLib.PRIORITY_DEFAULT, readCancellable);
                const chunkSize = bytes.get_size();
                if (chunkSize === 0) break; // EOF

                totalRead += chunkSize;
                this._debug(`[RawClipboard] 收到数据块: ${chunkSize} 字节，累计已读: ${totalRead} 字节`);
                if (totalRead > maxPayloadBytes) {
                    isOversized = true;
                    readCancellable.cancel(); // 显式下发中断信号，立刻切断底层管道对端数据泵送
                    break; // 触发前置熔断拦截
                }

                outputStream.write_bytes(bytes, null);
                resetWatchdog();
            }

            if (isOversized) {
                this._warn(`[RawClipboard] 提前熔断拦截超限剪贴板数据 (已超过上限 ${maxMb} MB)`);
                return;
            }

            // 三重守卫最终核验：任何一项条件触发导致被取消、超时或已被新 owner 抢占，彻底丢弃数据！
            if (readCancellable.is_cancelled() || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                this._log('[RawClipboard] 读取守卫命中（停滞超时/总耗时超限/所有者易手），彻底丢弃数据不入库');
                return;
            }

            outputStream.close(null);
            let gBytes = outputStream.steal_as_bytes();
            const size = gBytes.get_size();
            this._debug(`[RawClipboard] 数据流读取完毕，总大小: ${size} 字节`);
            if (size === 0) return;

            // 严格识别与拦截“剪切文件”操作 (Cut Files Filter)：
            // 剪切文件（Ctrl+X）在粘贴后源文件即被物理移动，无法重复回放，故严格禁止进入历史队列
            if (core.type === 'files') {
                let isCut = core.isKdeCut === true;
                if (!isCut) {
                    try {
                        const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
                        const rawHead = stream.read_bytes(100, null);
                        const str = Utf8Decoder.decode(rawHead);
                        const lines = str.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                        const action = lines[0]?.toLowerCase();
                        if (action === 'cut' || lines.includes('cut')) {
                            isCut = true;
                        }
                    } catch (_e) {}
                }
                if (isCut) {
                    this._log('[RawClipboard] 拦截剪切文件操作：源文件移动后不可回放，不进入历史队列');
                    return;
                }
            }

            // -------------------------------------------------------------
            // Radix Raw 前缀树存储与查重引擎 (Radix Raw History Engine)
            // -------------------------------------------------------------
            // 遍历插入即查重：直接将 raw 二进制流按 MIME 投递进 Radix Tree
            // 1. 若全路径完全匹配已有条目 -> 100% 相同内容 (Duplicate)
            //    - 更新该条目复制时间戳至最新时刻，统一确保其位于历史队首 (LRU 提升至队首)；
            // 2. 若前缀相同但在某处分叉 -> 自动裂变出公共前缀节点，共享前缀物理内存；
            // 3. 全新独立条目 -> 挂载为新分支，插入队首。
            this._debug(`[RawClipboard] 将数据投递至存储查重内核 (MIME: ${core.mime}, 大小: ${size} 字节)...`);
            const unknownLabel = (core.type === 'raw') ? this._getUnknownTypeName(core.mime) : null;
            const insertResult = this.#radixTree.insert(core.mime, gBytes, leafNode => {
                const previewInfo = generatePreview(core.type, core.mime, gBytes, unknownLabel);
                let cachedThumb = undefined;
                let assembledBytes = (leafNode.collectPathSegments().length === 1 ? leafNode.bytes : null);
                let cachedChecksum = null;
                const thisRef = this;
                let entryTime = copyTime;

                // 注意：entry.bytes/checksum/thumbIcon 采用惰性物化与按需缓存；
                // 前缀树在后续分裂重构时，各次访问内容恒定等价，但 bytes 对象身份可能按需更新。
                // 条目本身作为纯净只读视图冻结，不向外部泄露内部可变的 _radixNode。
                return Object.freeze({
                    id: `${copyTime}_${Math.floor(Math.random() * 1000)}`,
                    type: core.type,
                    mime: core.mime,
                    size: size,
                    get bytes() {
                        if (!assembledBytes) {
                            const segs = leafNode.collectPathSegments();
                            if (segs.length === 1) {
                                assembledBytes = segs[0];
                            } else {
                                const out = Gio.MemoryOutputStream.new_resizable();
                                for (const s of segs) {
                                    out.write_bytes(s, null);
                                }
                                out.close(null);
                                assembledBytes = out.steal_as_bytes();
                            }
                        }
                        return assembledBytes;
                    },
                    get checksum() {
                        if (!cachedChecksum) {
                            cachedChecksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, this.bytes);
                        }
                        return cachedChecksum;
                    },
                    get thumbIcon() {
                        if (cachedThumb === undefined) {
                            if (core.type === 'image') {
                                let maxThumbDim = 4096;
                                try {
                                    if (thisRef._settings && thisRef._settings.settings_schema && thisRef._settings.settings_schema.has_key('max-thumbnail-dimension')) {
                                        maxThumbDim = thisRef._settings.get_int('max-thumbnail-dimension');
                                    }
                                } catch (_e) {}
                                cachedThumb = thisRef._generateThumbnail(this.bytes, core.mime, maxThumbDim);
                            } else {
                                cachedThumb = null;
                            }
                        }
                        return cachedThumb;
                    },
                    preview: previewInfo.title,
                    subtitle: previewInfo.subtitle,
                    icon: previewInfo.icon,
                    get time() { return entryTime; },
                    set time(val) { if (typeof val === 'number') entryTime = val; },
                });
            });

            if (insertResult.isDuplicate) {
                const existing = insertResult.existingEntry;
                try {
                    existing.time = copyTime;
                } catch (_) {}

                if (this.#deletedEntries.has(existing)) {
                    this.#deletedEntries.delete(existing);
                    this._undoStack = this._undoStack.filter(e => e !== existing);
                    this._updateUndoButton();
                }

                // 统一提升至队首（若已在队首则保持，非队首则移至队首）
                const existingIdx = this.#history.indexOf(existing);
                if (existingIdx !== 0) {
                    if (existingIdx > 0) {
                        this.#history.splice(existingIdx, 1);
                    }
                    this.#history.unshift(existing);
                    this._log(`[RawClipboard] 命中历史相同条目，LRU 提升至队首: ${this._formatEntryLog(existing)}`);
                } else {
                    this._debug(`[RawClipboard] 命中队首相同条目（连续复制），更新时间戳: ${this._formatEntryLog(existing)}`);
                }

                if (this._popup && this._popup.visible) {
                    this._queueRender();
                }
                return;
            }

            // 再次校验生命周期与抢占状态，若在读取或处理过程中已被取消或抢占，则放弃入库
            if (!this._cancellable || this._cancellable.is_cancelled() ||
                readCancellable.is_cancelled() ||
                this._currentReadCancellable !== readCancellable) {
                this._log('[RawClipboard] 读取已过时或被新所有者抢占，放弃入库');
                this.#radixTree.remove(insertResult.newEntry);
                return;
            }

            this.#history.unshift(insertResult.newEntry);
            this._log(`[RawClipboard] 成功记录新剪贴板条目: ${this._formatEntryLog(insertResult.newEntry)}，当前历史总数: ${this.#history.length}`);
            this._enforceLimit();
            gBytes = null;

            // 若当前弹窗打开，合并空闲帧刷新列表
            if (this._popup && this._popup.visible) {
                this._queueRender();
            }
        } catch (e) {
            if (readCancellable.is_cancelled() || (e.matches && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))) {
                this._log('[RawClipboard] 读取已取消');
                return;
            }
            this._warn('[RawClipboard] Capture error:', e.message);
        } finally {
            if (overallSettingsChangedId > 0 && this._settings) {
                try {
                    this._settings.disconnect(overallSettingsChangedId);
                } catch (_) {}
                overallSettingsChangedId = 0;
            }
            if (watchdogId > 0) {
                GLib.source_remove(watchdogId);
                watchdogId = 0;
            }
            if (overallTimeoutId > 0) {
                GLib.source_remove(overallTimeoutId);
                overallTimeoutId = 0;
            }
            if (parentCancelId > 0 && this._cancellable) {
                this._cancellable.disconnect(parentCancelId);
            }
            if (this._currentReadCancellable === readCancellable) {
                this._currentReadCancellable = null;
            }
            if (inputStream) {
                try { inputStream.close(null); } catch (_) {}
            }
            if (outputStream) {
                try { outputStream.close(null); } catch (_) {}
            }
        }
    }

    _enforceLimit() {
        const rawMaxItems = this._settings ? this._settings.get_int('max-items') : 30;
        const maxItems = Math.max(5, Math.min(1000, Number.isInteger(rawMaxItems) ? rawMaxItems : 30));
        const rawMaxMb = this._settings ? this._settings.get_int('max-size-mb') : 50;
        const maxSingleBytes = Math.max(5, Math.min(1024, Number.isInteger(rawMaxMb) ? rawMaxMb : 50)) * 1024 * 1024;
        const rawTotalMb = this._settings ? this._settings.get_int('max-total-size-mb') : 1024;
        const maxTotalMb = Math.max(50, Math.min(4096, Number.isInteger(rawTotalMb) ? rawTotalMb : 1024));
        const maxTotalBytes = maxTotalMb * 1024 * 1024;

        // 1. 单项容量上限裁剪 (修改此限制时，自动移除所有超出此限制的记录)
        for (let i = this.#history.length - 1; i >= 0; i--) {
            const item = this.#history[i];
            const size = typeof item.size === 'number' ? item.size : (item.bytes ? item.bytes.get_size() : 0);
            if (size > maxSingleBytes) {
                this._log(`[RawClipboard] 条目超出单项容量限制 (${rawMaxMb} MB)，移除该条目: ${this._formatEntryLog(item)}`);
                this.#history.splice(i, 1);
                this.#radixTree.remove(item);
                if (this.#deletedEntries.has(item)) {
                    this.#deletedEntries.delete(item);
                    this._undoStack = this._undoStack.filter(e => e !== item);
                }
            }
        }

        // 2. 条数上限裁剪 (FIFO: 若剪贴板历史记录数量超出此限制，则自动移除最早的一项记录)
        while (this.#history.length > maxItems) {
            const popped = this.#history.pop();
            if (popped) {
                this._log(`[RawClipboard] 超过最大历史条数限制 (${maxItems} 条)，淘汰最旧条目: ${this._formatEntryLog(popped)}`);
                this.#radixTree.remove(popped);
                if (this.#deletedEntries.has(popped)) {
                    this.#deletedEntries.delete(popped);
                    this._undoStack = this._undoStack.filter(e => e !== popped);
                }
            }
        }

        // 3. 全局总内存上限裁剪 (FIFO: 若存储树总大小超出此限制，则自动移除最早的一项或多项记录，直到存储树总大小低于此限制)
        let totalBytes = this.#history.reduce((sum, item) => sum + (typeof item.size === 'number' ? item.size : (item.bytes ? item.bytes.get_size() : 0)), 0);
        while (this.#history.length > 0 && totalBytes > maxTotalBytes) {
            const popped = this.#history.pop();
            if (popped) {
                this._log(`[RawClipboard] 超过历史总内存上限 (${maxTotalMb} MB)，淘汰最旧条目: ${this._formatEntryLog(popped)}`);
                this.#radixTree.remove(popped);
                if (this.#deletedEntries.has(popped)) {
                    this.#deletedEntries.delete(popped);
                    this._undoStack = this._undoStack.filter(e => e !== popped);
                }
                totalBytes -= (typeof popped.size === 'number' ? popped.size : (popped.bytes ? popped.bytes.get_size() : 0));
            }
        }

        this._updateUndoButton();

        // 若弹窗正处于打开状态，合并刷新列表
        if (this._popup && this._popup.visible) {
            this._queueRender();
        }
    }

    _restoreEntry(entry) {
        const entrySize = typeof entry?.size === 'number' ? entry.size : (entry?.bytes?.get_size ? entry.bytes.get_size() : 0);
        if (entrySize <= 0) return;
        this._log(`[RawClipboard] 正在恢复条目至系统剪贴板: ${this._formatEntryLog(entry)} (MIME: ${entry.mime})`);

        try {
            if (this.#deletedEntries.has(entry)) {
                this.#deletedEntries.delete(entry);
                this._undoStack = this._undoStack.filter(e => e !== entry);
                this._updateUndoButton();
            }

            // 1. 零拷贝提升：直接在内部指针数组中将选中项移动到队首 (LRU)
            const idx = this.#history.indexOf(entry);
            if (idx > 0) {
                this.#history.splice(idx, 1);
                this.#history.unshift(entry);
            }

            // 2. 生成单次回环标识并挂载至数据源对象
            const nonce = GLib.uuid_string_random();
            this.#activeNonces.add(nonce);

            // 500ms 超时清理，防止未触发 owner-changed 时标识滞留
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this.#activeNonces.delete(nonce);
                return GLib.SOURCE_REMOVE;
            });

            this._isRestoring = true;
            try {
                let source = null;
                // 保持原始捕获的 MIME 声明原样回灌，不额外追加参数
                const mime = entry.mime;

                if (Meta && Meta.SelectionSourceMemory && typeof Meta.SelectionSourceMemory.new === 'function') {
                    try {
                        source = Meta.SelectionSourceMemory.new(mime, entry.bytes);
                    } catch (_e) {}
                }

                if (source) {
                    source[RESTORE_NONCE] = nonce;
                    if (this._selection && typeof this._selection.set_owner === 'function') {
                        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
                    } else {
                        const clipboard = St.Clipboard.get_default();
                        clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, entry.bytes);
                    }
                } else {
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, entry.bytes);
                }
                this._debug('[RawClipboard] 成功写回系统剪贴板并挂载防回环标识');
            } finally {
                this._isRestoring = false;
            }
        } catch (e) {
            this._error('[RawClipboard] Restore failed:', e);
        }
    }

    _deleteEntry(indexOrEntry) {
        if (!this._popup) {
            // 弹窗未打开时（无交互界面 / 单元测试场景），直接物理删除
            if (typeof indexOrEntry === 'number') {
                if (!Number.isInteger(indexOrEntry) || indexOrEntry < 0 || indexOrEntry >= this.#history.length) return;
                const [removed] = this.#history.splice(indexOrEntry, 1);
                if (removed) {
                    this.#radixTree.remove(removed);
                }
            } else if (indexOrEntry && typeof indexOrEntry === 'object') {
                const idx = this.#history.indexOf(indexOrEntry);
                if (idx !== -1) {
                    this.#history.splice(idx, 1);
                    this.#radixTree.remove(indexOrEntry);
                }
            }
            return;
        }

        // 弹窗处于打开状态：存储层只标记删除，位置不变
        const sortedEntries = this._getSortedEntries();
        let entry = null;
        if (typeof indexOrEntry === 'number') {
            if (!Number.isInteger(indexOrEntry) || indexOrEntry < 0 || indexOrEntry >= sortedEntries.length) return;
            entry = sortedEntries[indexOrEntry];
        } else if (indexOrEntry && typeof indexOrEntry === 'object') {
            entry = indexOrEntry;
        }
        if (!entry) return;

        this.#deletedEntries.add(entry);
        this._undoStack.push(entry);
        this._debug(`[RawClipboard] 暂存删除历史条目: ${this._formatEntryLog(entry)} (待删除条目数: ${this.#deletedEntries.size})`);

        const remainingCount = sortedEntries.length - 1;
        const totalPages = Math.max(1, Math.ceil(remainingCount / 8));
        if (this._currentPage >= totalPages) {
            this._currentPage = Math.max(0, totalPages - 1);
        }

        const startIndex = this._currentPage * 8;
        const pageCount = Math.max(0, Math.min(8, remainingCount - startIndex));
        if (this._selectedIndex >= pageCount) {
            this._selectedIndex = Math.max(0, pageCount - 1);
        }

        // 窗口尺寸严格常驻固定，无论删除、撤销多少都不改变
        this._renderPage();
        this._updatePageBadge();
        this._updateUndoButton();
    }

    _undoLastDelete() {
        if (!this._undoStack || this._undoStack.length === 0) return false;
        const entry = this._undoStack.pop();
        if (!entry) return false;

        this.#deletedEntries.delete(entry);
        this._debug(`[RawClipboard] 撤销删除，已恢复条目: ${this._formatEntryLog(entry)}`);

        const sortedEntries = this._getSortedEntries();
        const sortedIndex = sortedEntries.indexOf(entry);
        if (sortedIndex !== -1) {
            // 选中项跳转到被恢复项所在页和索引
            const restoredPage = Math.floor(sortedIndex / 8);
            const restoredPageIdx = sortedIndex % 8;
            this._currentPage = restoredPage;
            this._selectedIndex = restoredPageIdx;
        }

        // 窗口尺寸严格常驻固定，无论删除、撤销多少都不改变
        this._renderPage();
        this._updatePageBadge();
        this._updateUndoButton();
        return true;
    }

    _commitPendingDeletions() {
        if (this.#deletedEntries.size > 0) {
            const count = this.#deletedEntries.size;
            this.#history = this.#history.filter(entry => {
                if (this.#deletedEntries.has(entry)) {
                    this.#radixTree.remove(entry);
                    return false;
                }
                return true;
            });
            this.#deletedEntries.clear();
            this._undoStack = [];
            this._log(`[RawClipboard] 退出窗口，物理提交删除 ${count} 项条目，当前剩余历史总数: ${this.#history.length}`);
        }
    }

    _updateUndoButton() {
        if (!this._undoBtn) return;
        const canUndo = Boolean(this._undoStack && this._undoStack.length > 0);
        this._undoBtn.reactive = canUndo;
        if (canUndo) {
            this._undoBtn.remove_style_class_name('disabled');
            this._undoBtn.add_style_class_name('active');
        } else {
            this._undoBtn.remove_style_class_name('active');
            this._undoBtn.add_style_class_name('disabled');
        }
    }

    _calculateDesiredDimensions(monitor) {
        // 窗口尺寸直接常驻固定为 8 个条目的尺寸 + 顶部排序栏 + 底部区域 (34px + 398px + 14px + 28px = 474px)
        // 彻底消除条目变动或弹窗期间新增复制导致的尺寸跳动与条目溢出
        const popupWidth = 420;
        const maxDisplayCount = 8;
        const itemHeight = 48;
        const itemSpacing = 2;
        const popupPaddingY = 12; // 容器上下内边距 6px + 6px
        const popupBorderY = 2;   // 边框 1px + 1px
        const sortBarHeight = 34; // 顶部排序栏高度 (调大至 34px 匹配 1em 字体)
        const pageBarHeight = 28; // 底部区域高度 (撤销按钮与页码共享)

        let contentHeight = maxDisplayCount * itemHeight + (maxDisplayCount - 1) * itemSpacing; // 398px
        let popupHeight = sortBarHeight + contentHeight + popupPaddingY + popupBorderY + pageBarHeight; // 474px
        const effectivePageBarHeight = pageBarHeight;

        // 严密屏幕边界安全防御
        const maxMonitorHeight = monitor ? (monitor.height - 64) : 800;
        if (popupHeight > maxMonitorHeight) {
            popupHeight = maxMonitorHeight;
            contentHeight = Math.max(50, popupHeight - popupPaddingY - popupBorderY - sortBarHeight - effectivePageBarHeight);
        }

        return {
            popupWidth,
            popupHeight,
            contentHeight,
            sortBarHeight,
            pageBarHeight: effectivePageBarHeight,
        };
    }

    _updatePageBadge() {
        if (!this._pageBadge) return;
        const currentEntries = this._getSortedEntries();
        const totalCount = currentEntries.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / 8));
        if (totalCount === 0 || totalPages <= 1) {
            this._pageBadge.hide();
            this._pageBadge.text = '';
        } else {
            this._pageBadge.text = `${this._currentPage + 1} / ${totalPages}`;
            this._pageBadge.show();
        }
    }

    _togglePopup() {
        this._debug('[RawClipboard] 快捷键触发窗口显示/隐藏切换');
        if (this._container && !this._isClosing) {
            this._closePopup();
        } else if (!this._container) {
            this._openPopup();
        }
    }

    _openPopup() {
        if (this._container || this._isClosing) return;
        this._debug(`[RawClipboard] 打开剪贴板窗口，当前历史总数: ${this.#history.length} (可见条目数: ${this._getVisibleEntries().length})`);

        this.#deletedEntries.clear();
        this._undoStack = [];
        this._inSearchMode = false;
        this._searchQuery = '';

        try {
            // 1. 获取鼠标指针位置与显示器
            const [mouseX, mouseY] = global.get_pointer();

            let monitor = Main.layoutManager.primaryMonitor;
            const monitors = Main.layoutManager.monitors || [];
            for (const m of monitors) {
                if (mouseX >= m.x && mouseX < m.x + m.width && mouseY >= m.y && mouseY < m.y + m.height) {
                    monitor = m;
                    break;
                }
            }
            if (!monitor) {
                monitor = { x: 0, y: 0, width: global.stage.width, height: global.stage.height };
            }

            // 2. 全屏透明遮罩容器：捕获点击空白处事件，同时承担模态焦点与按键路由
            this._container = new Clutter.Actor({
                name: 'rawClipboardModalContainer',
                reactive: true,
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
            });

            // 3. 构建弹窗主体容器（全面继承 GNOME 官方 popup-menu-content 原生规范）
            this._popup = new St.BoxLayout({
                name: 'rawClipboardPopup',
                style_class: 'popup-menu-content raw-clipboard-popup',
                orientation: Clutter.Orientation.VERTICAL,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            // 阻断弹窗内部的点击事件冒泡，若处于搜索状态，点击弹窗空白区域优先退出搜索状态
            this._popup.connect('button-press-event', () => {
                if (this._inSearchMode) {
                    this._exitSearchMode();
                }
                return Clutter.EVENT_STOP;
            });

            // 计算定位与严格尺寸约束 (直接常驻固定为 8 个条目的尺寸 + 顶部排序栏 + 底部区域: 468px)
            const { popupWidth, popupHeight, contentHeight, pageBarHeight, sortBarHeight } = this._calculateDesiredDimensions(monitor);
            const contentWidth = popupWidth - 12;

            // 顶部排序栏容器 (4个排序切换按钮：记录顺序、大小、类型、首字母)
            this._sortBar = new St.BoxLayout({
                style_class: 'raw-clipboard-sort-bar',
                orientation: Clutter.Orientation.HORIZONTAL,
                reactive: true,
                x_expand: true,
                y_expand: false,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._sortButtons = new Map();
            const sortOptions = [
                { id: 'queue', label: '记录顺序' },
                { id: 'size', label: '大小' },
                { id: 'type', label: '类型' },
                { id: 'initial', label: '首字母' },
            ];

            sortOptions.forEach(opt => {
                const btnLabel = new St.Label({
                    text: opt.label,
                    style_class: 'raw-clipboard-sort-label',
                    reactive: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                if (btnLabel.clutter_text) {
                    btnLabel.clutter_text.use_markup = false;
                }
                const btn = new St.Button({
                    style_class: `raw-clipboard-sort-btn ${this._sortMode === opt.id ? 'active' : ''}`,
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    child: btnLabel,
                });
                btn.connect('button-press-event', (_actor, event) => {
                    if (event.get_button() === 1) {
                        this._setSortMode(opt.id);
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                btn.connect('button-release-event', () => Clutter.EVENT_STOP);
                btn.connect('clicked', () => {
                    this._setSortMode(opt.id);
                });
                this._sortButtons.set(opt.id, btn);
                this._sortBar.add_child(btn);
            });
            this._popup.add_child(this._sortBar);

            // 顶部搜索栏容器 (平时隐藏，键入文字时自动替代排序栏)
            this._searchBar = new St.BoxLayout({
                style_class: 'raw-clipboard-search-bar',
                orientation: Clutter.Orientation.HORIZONTAL,
                reactive: true,
                x_expand: true,
                y_expand: false,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            this._searchBar.connect('button-press-event', () => {
                if (this._searchEntry) {
                    this._searchEntry.grab_key_focus();
                }
                return Clutter.EVENT_STOP;
            });

            const searchIcon = new St.Icon({
                icon_name: 'system-search-symbolic',
                icon_size: 14,
                style_class: 'raw-clipboard-search-icon',
                y_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });

            // 搜索输入框：原生支持光标、文本选择、剪贴板粘贴与中文输入法 (IME)
            this._searchEntry = new St.Entry({
                style_class: 'raw-clipboard-search-entry',
                hint_text: '搜索预览内容...',
                can_focus: true,
                reactive: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._searchEntry.connect('button-press-event', () => Clutter.EVENT_PROPAGATE);
            if (this._searchEntry.clutter_text) {
                this._searchEntry.clutter_text.use_markup = false;
                if (typeof this._searchEntry.clutter_text.connect === 'function') {
                    this._searchEntry.clutter_text.connect('text-changed', () => {
                        this._onSearchTextChanged();
                    });
                    this._searchEntry.clutter_text.connect('key-press-event', (_actor, event) => {
                        return this._onSearchEntryKeyPress(event);
                    });
                }
            }

            this._searchBar.add_child(searchIcon);
            this._searchBar.add_child(this._searchEntry);
            this._popup.add_child(this._searchBar);

            // 列表条目容器：直接放置于弹窗主体内，彻底弃用滚动条，根除不整齐切割
            this._listContainer = new St.BoxLayout({
                style_class: 'raw-clipboard-list',
                orientation: Clutter.Orientation.VERTICAL,
                reactive: true,
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.START,
            });
            this._listContainer.connect('button-press-event', () => {
                if (this._inSearchMode) {
                    this._exitSearchMode();
                }
                return Clutter.EVENT_STOP;
            });
            this._popup.add_child(this._listContainer);

            // 底部区域容器：置于弹窗主体底部，包含左侧撤销按钮与右侧页码指示器
            this._pageBar = new St.BoxLayout({
                style_class: 'raw-clipboard-page-bar',
                orientation: Clutter.Orientation.HORIZONTAL,
                reactive: true,
                x_expand: true,
                y_expand: false,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._pageBar.connect('button-press-event', () => {
                if (this._inSearchMode) {
                    this._exitSearchMode();
                }
                return Clutter.EVENT_STOP;
            });

            // 左下角撤销按钮 (扁平化轻量设计，与页码共享底部区域)
            const undoIcon = new St.Icon({
                icon_name: 'edit-undo-symbolic',
                icon_size: 14,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const undoLabel = new St.Label({
                text: '撤销',
                style_class: 'raw-clipboard-undo-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (undoLabel.clutter_text) {
                undoLabel.clutter_text.use_markup = false;
            }

            const undoBox = new St.BoxLayout({
                style_class: 'raw-clipboard-undo-box',
                orientation: Clutter.Orientation.HORIZONTAL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            undoBox.add_child(undoIcon);
            undoBox.add_child(undoLabel);

            this._undoBtn = new St.Button({
                style_class: 'raw-clipboard-undo-btn disabled',
                reactive: false,
                can_focus: true,
                track_hover: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                child: undoBox,
            });

            this._undoBtn.connect('clicked', () => {
                this._undoLastDelete();
            });
            this._undoBtn.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 1 && this._undoBtn.reactive) {
                    this._undoLastDelete();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._pageBar.add_child(this._undoBtn);

            // 右下角页码指示器 (靠右排列)
            this._pageBadge = new St.Label({
                style_class: 'raw-clipboard-page-badge',
                reactive: false,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (this._pageBadge.clutter_text) {
                this._pageBadge.clutter_text.use_markup = false;
                this._pageBadge.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                this._pageBadge.clutter_text.line_alignment = Pango.Alignment.RIGHT;
                this._pageBadge.clutter_text.x_align = Clutter.ActorAlign.END;
            }

            this._pageBar.add_child(this._pageBadge);
            this._popup.add_child(this._pageBar);

            // 将弹窗装入全屏遮罩容器，并将遮罩挂载到 uiGroup
            this._container.add_child(this._popup);
            Main.layoutManager.uiGroup.add_child(this._container);

            this._popup.set_size(popupWidth, popupHeight);
            this._popup.width = popupWidth;
            this._popup.height = popupHeight;
            this._popup.min_height = popupHeight;
            this._popup.max_height = popupHeight;

            if (sortBarHeight > 0) {
                this._sortBar.set_size(contentWidth, sortBarHeight);
                this._sortBar.width = contentWidth;
                this._sortBar.height = sortBarHeight;
                this._sortBar.min_height = sortBarHeight;
                this._sortBar.max_height = sortBarHeight;
                this._sortBar.show();

                this._searchBar.set_size(contentWidth, sortBarHeight);
                this._searchBar.width = contentWidth;
                this._searchBar.height = sortBarHeight;
                this._searchBar.min_height = sortBarHeight;
                this._searchBar.max_height = sortBarHeight;
                this._searchBar.hide();
            } else {
                this._sortBar.hide();
                this._searchBar.hide();
            }

            this._listContainer.set_size(contentWidth, contentHeight);
            this._listContainer.width = contentWidth;
            this._listContainer.height = contentHeight;
            this._listContainer.min_height = contentHeight;
            this._listContainer.max_height = contentHeight;

            if (pageBarHeight > 0) {
                this._pageBar.set_size(contentWidth, pageBarHeight);
                this._pageBar.width = contentWidth;
                this._pageBar.height = pageBarHeight;
                this._pageBar.min_height = pageBarHeight;
                this._pageBar.max_height = pageBarHeight;
                this._pageBar.show();
            } else {
                this._pageBar.hide();
            }

            let posX = mouseX + 8;
            let posY = mouseY + 8;

            if (posX + popupWidth > monitor.x + monitor.width - 8) {
                posX = mouseX - popupWidth - 8;
            }
            if (posY + popupHeight > monitor.y + monitor.height - 8) {
                posY = mouseY - popupHeight - 8;
            }

            posX = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - popupWidth - 8, posX));
            posY = Math.max(monitor.y + 8, Math.min(monitor.y + monitor.height - popupHeight - 8, posY));

            this._popup.set_position(posX, posY);

            // 鼠标滚轮翻页监听 (滚轮向下翻至下一页，向上翻至上一页，灵敏平滑防抖)
            let lastScrollTime = 0;
            let lastScrollDir = 0;
            let smoothAccumulator = 0;
            const SCROLL_DEBOUNCE_MS = 60; // 60ms 极速防抖：过滤瞬间机械抖动，同时确保连续滚轮与方向键一致的瞬时响应

            const handleScrollEvent = (_actor, event) => {
                const currentEntries = this._getSortedEntries();
                const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
                if (totalPages <= 1) return Clutter.EVENT_STOP;

                const now = Date.now();
                const direction = event.get_scroll_direction();
                let delta = 0;

                if (direction === Clutter.ScrollDirection.UP) {
                    delta = -1;
                } else if (direction === Clutter.ScrollDirection.DOWN) {
                    delta = 1;
                } else if (direction === Clutter.ScrollDirection.SMOOTH) {
                    const [, dy] = event.get_scroll_delta();
                    if (now - lastScrollTime > 250) {
                        smoothAccumulator = 0;
                    }
                    smoothAccumulator += dy;
                    if (smoothAccumulator >= 0.25) {
                        delta = 1;
                        smoothAccumulator = 0;
                    } else if (smoothAccumulator <= -0.25) {
                        delta = -1;
                        smoothAccumulator = 0;
                    } else {
                        return Clutter.EVENT_STOP;
                    }
                }

                if (delta !== 0) {
                    // 反向滚动立即响应零延迟；同向滚动应用 60ms 防抖，保障连续滚轮与方向键一致的顺滑
                    const isReversal = (lastScrollDir !== 0 && delta !== lastScrollDir);
                    if (!isReversal && (now - lastScrollTime < SCROLL_DEBOUNCE_MS)) {
                        return Clutter.EVENT_STOP;
                    }

                    // 循环翻页：第一页向上翻至末页，末页向下翻至第一页
                    const targetPage = (this._currentPage + delta + totalPages) % totalPages;
                    lastScrollTime = now;
                    lastScrollDir = delta;
                    this._setPage(targetPage, this._selectedIndex);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            };

            this._popup.connect('scroll-event', handleScrollEvent);
            this._container.connect('scroll-event', handleScrollEvent);

            // 渲染当前页条目与更新页码
            this._currentPage = 0;
            this._selectedIndex = 0;
            this._renderPage();
            this._updatePageBadge();
            this._updateUndoButton();

            // 4. 点击空白处关闭弹窗：用户点击全屏遮罩任何非弹窗区域即刻触发关闭
            // 若处于搜索状态，优先退出搜索状态而不关闭弹窗
            this._container.connect('button-press-event', (_actor, _event) => {
                if (this._inSearchMode) {
                    this._exitSearchMode();
                    return Clutter.EVENT_STOP;
                }
                this._closePopup();
                return Clutter.EVENT_STOP;
            });

            // 5. 监听键盘按键
            this._container.connect('key-press-event', (_actor, event) => {
                return this._onKeyPress(event);
            });

            // 6. 模态焦点锁定 (弹窗使用 POPUP 模式，避免与锁屏/全局模态模式冲突)
            this._grab = Main.pushModal(this._container, { actionMode: Shell.ActionMode.POPUP });
            const grabSuccess = Boolean(this._grab && (typeof this._grab === 'object' || this._grab !== 0));
            if (!grabSuccess) {
                this._warn('[RawClipboard] 模态焦点抓取失败（当前可能处于全局独占模式），安全取消弹窗');
                this._closePopup();
                return;
            }

            // 7. GNOME 官方标准原生淡入动画（纯透明度渐变，严禁使用 scale/pivot 避免矩阵偏移）
            this._popup.opacity = 0;

            const animDuration = shouldUseMotion() ? 120 : 0;

            if (animDuration > 0) {
                this._popup.ease({
                    opacity: 255,
                    duration: animDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                this._popup.opacity = 255;
            }
        } catch (e) {
            this._error('[RawClipboard] Open popup failed:', e);
            if (this._container) {
                try {
                    const parent = this._container.get_parent ? this._container.get_parent() : this._container.parent;
                    if (parent && typeof parent.remove_child === 'function') {
                        parent.remove_child(this._container);
                    } else {
                        Main.layoutManager.uiGroup.remove_child(this._container);
                    }
                } catch (_) {}
                try { this._container.destroy(); } catch (_) {}
                this._container = null;
                this._popup = null;
                this._sortBar = null;
                this._sortButtons = null;
                this._searchBar = null;
                this._searchEntry = null;
                this._emptyLabel = null;
                this._listContainer = null;
                this._pageBar = null;
                this._pageBadge = null;
                this._undoBtn = null;
                this._itemSlots = null;
                this._itemActors = null;
                this._sortMode = 'queue';
                this._inSearchMode = false;
                this._searchQuery = '';
            }
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
        }
    }

    _closePopup() {
        if (!this._container || this._isClosing) return;
        this._isClosing = true;
        this._debug('[RawClipboard] 关闭剪贴板窗口');

        // 退出弹窗后，统一执行物理删除
        this._commitPendingDeletions();

        // 立即释放模态抓取，确保键盘和系统焦点即时回归
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        // 禁用遮罩交互，防止动画期间误触
        this._container.reactive = false;

        const animDuration = shouldUseMotion() ? 100 : 0;

        const cleanup = () => {
            if (this._container) {
                try {
                    const parent = this._container.get_parent ? this._container.get_parent() : this._container.parent;
                    if (parent && typeof parent.remove_child === 'function') {
                        parent.remove_child(this._container);
                    } else {
                        Main.layoutManager.uiGroup.remove_child(this._container);
                    }
                } catch (_) {}
                this._container.destroy();
                this._container = null;
                this._popup = null;
                this._sortBar = null;
                this._sortButtons = null;
                this._searchBar = null;
                this._searchEntry = null;
                this._emptyLabel = null;
                this._listContainer = null;
                this._pageBar = null;
                this._pageBadge = null;
                this._undoBtn = null;
                this._itemSlots = null;
                this._itemActors = null; // 切断 UI 控件对 entry 的闭包持有，允许 GC 即时回收
                this._sortMode = 'queue';
                this._inSearchMode = false;
                this._searchQuery = '';
            }
            this._isClosing = false;
        };

        if (animDuration > 0 && this._popup) {
            this._popup.ease({
                opacity: 0,
                duration: animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: cleanup,
            });
        } else {
            cleanup();
        }
    }

    _setPage(pageIndex, newSelectedIndex = null) {
        const currentEntries = this._getSortedEntries();
        const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
        if (pageIndex < 0 || pageIndex >= totalPages) return;

        this._currentPage = pageIndex;
        const startIndex = this._currentPage * 8;
        const pageCount = Math.min(8, currentEntries.length - startIndex);

        if (newSelectedIndex !== null) {
            this._selectedIndex = Math.max(0, Math.min(newSelectedIndex, pageCount - 1));
        } else if (this._selectedIndex >= pageCount) {
            this._selectedIndex = Math.max(0, pageCount - 1);
        }

        this._renderPage();
        this._updatePageBadge();
    }

    _renderList() {
        return this._queueRender();
    }

    _createSlot(slotIndex) {
        const itemBox = new St.BoxLayout({
            style_class: 'raw-clipboard-item',
            orientation: Clutter.Orientation.HORIZONTAL,
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (typeof itemBox.set_height === 'function') {
            itemBox.set_height(48);
        }
        itemBox.height = 48;
        itemBox.min_height = 48;
        itemBox.max_height = 48;

        // 图标 / 缩略图
        const iconActor = new St.Icon({
            icon_name: 'edit-copy-symbolic',
            style_class: 'raw-clipboard-item-icon',
            icon_size: 20,
            y_align: Clutter.ActorAlign.CENTER,
        });
        itemBox.add_child(iconActor);

        // 内容文本区
        const contentBox = new St.BoxLayout({
            style_class: 'raw-clipboard-item-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const previewLabel = new St.Label({
            text: '',
            style_class: 'raw-clipboard-item-preview',
        });
        if (previewLabel.clutter_text) {
            previewLabel.clutter_text.use_markup = false;
            previewLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }

        const subLabel = new St.Label({
            text: '',
            style_class: 'raw-clipboard-item-sub',
        });
        if (subLabel.clutter_text) {
            subLabel.clutter_text.use_markup = false;
        }

        contentBox.add_child(previewLabel);
        contentBox.add_child(subLabel);
        itemBox.add_child(contentBox);

        // 复制时间展示 (右侧对齐，位于内容与删除按钮之间)
        const timeLabel = new St.Label({
            text: '',
            style_class: 'raw-clipboard-item-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (timeLabel.clutter_text) {
            timeLabel.clutter_text.use_markup = false;
        }
        itemBox.add_child(timeLabel);

        // 扁平化垃圾桶删除按钮 (48x48 正方形点击热区，居于条目右侧)
        const deleteIcon = new St.Icon({
            icon_name: 'user-trash-symbolic',
            icon_size: 16,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const deleteBtn = new St.Button({
            style_class: 'raw-clipboard-delete-btn',
            can_focus: true,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            child: deleteIcon,
        });
        deleteBtn.set_size(48, 48);
        deleteBtn.width = 48;
        deleteBtn.height = 48;

        const slot = {
            itemBox,
            iconActor,
            contentBox,
            previewLabel,
            subLabel,
            timeLabel,
            deleteBtn,
            currentEntry: null,
            currentGIcon: null,
            currentIconName: null,
        };

        deleteBtn.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 1 && slot.currentEntry) {
                this._deleteEntry(slot.currentEntry);
            }
            return Clutter.EVENT_STOP;
        });
        deleteBtn.connect('button-release-event', () => Clutter.EVENT_STOP);
        deleteBtn.connect('clicked', () => {
            if (slot.currentEntry) {
                this._deleteEntry(slot.currentEntry);
            }
        });
        itemBox.add_child(deleteBtn);

        // 点击条目恢复 (删除按钮自身已消费事件并停止冒泡，抵达此处的事件必然是条目正文点击)
        itemBox.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 1 && slot.currentEntry) {
                try {
                    this._restoreEntry(slot.currentEntry);
                    this._closePopup();
                } catch (e) {
                    this._error('[RawClipboard] Restore on click failed:', e);
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // 悬停高亮
        itemBox.connect('notify::hover', () => {
            if (itemBox.hover) {
                this._setSelectedIndex(slotIndex);
            }
        });

        return slot;
    }

    _renderPage() {
        if (this._renderIdleId) {
            GLib.source_remove(this._renderIdleId);
            this._renderIdleId = 0;
        }
        if (!this._listContainer) return;

        if (!this._itemSlots) {
            this._itemSlots = [];
        }

        const sortedEntries = this._getSortedEntries();
        const totalCount = sortedEntries.length;

        if (totalCount === 0) {
            this._currentPage = 0;
            this._selectedIndex = 0;
            this._itemActors = [];

            // 隐藏所有槽位
            for (const slot of this._itemSlots) {
                slot.currentEntry = null;
                slot.itemBox.hide();
            }

            if (!this._emptyLabel) {
                this._emptyLabel = new St.Label({
                    text: this._inSearchMode ? '无匹配项目' : '剪贴板历史为空',
                    style_class: 'raw-clipboard-empty',
                    reactive: true,
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                if (this._emptyLabel.clutter_text) {
                    this._emptyLabel.clutter_text.use_markup = false;
                }
                this._emptyLabel.connect('button-press-event', () => {
                    if (this._inSearchMode) {
                        this._exitSearchMode();
                    }
                    return Clutter.EVENT_STOP;
                });
                this._listContainer.add_child(this._emptyLabel);
            }
            this._emptyLabel.text = this._inSearchMode ? '无匹配项目' : '剪贴板历史为空';
            this._emptyLabel.show();
            return;
        }

        if (this._emptyLabel) {
            this._emptyLabel.hide();
        }

        const totalPages = Math.max(1, Math.ceil(totalCount / 8));
        if (this._currentPage >= totalPages) {
            this._currentPage = Math.max(0, totalPages - 1);
        }
        const startIndex = this._currentPage * 8;
        const pageItems = sortedEntries.slice(startIndex, startIndex + 8);
        if (this._selectedIndex >= pageItems.length) {
            this._selectedIndex = Math.max(0, pageItems.length - 1);
        }

        for (let i = 0; i < pageItems.length; i++) {
            const entry = pageItems[i];
            let slot = this._itemSlots[i];
            if (!slot) {
                slot = this._createSlot(i);
                this._itemSlots[i] = slot;
                this._listContainer.add_child(slot.itemBox);
            }

            slot.currentEntry = entry;

            // 1. 图标/缩略图：仅在真实变更时更新，彻底杜绝材质销毁导致的闪烁
            if (entry.thumbIcon) {
                if (slot.currentGIcon !== entry.thumbIcon) {
                    slot.iconActor.icon_name = null;
                    slot.iconActor.gicon = entry.thumbIcon;
                    slot.iconActor.style_class = 'raw-clipboard-item-thumb';
                    slot.iconActor.icon_size = 34;
                    slot.currentGIcon = entry.thumbIcon;
                    slot.currentIconName = null;
                }
            } else {
                const iconName = entry.icon || 'edit-copy-symbolic';
                if (slot.currentIconName !== iconName || slot.currentGIcon !== null) {
                    slot.iconActor.gicon = null;
                    slot.iconActor.icon_name = iconName;
                    slot.iconActor.style_class = 'raw-clipboard-item-icon';
                    slot.iconActor.icon_size = 20;
                    slot.currentIconName = iconName;
                    slot.currentGIcon = null;
                }
            }

            // 2. 文字与时间在位更新
            if (slot.previewLabel.text !== entry.preview) {
                slot.previewLabel.text = entry.preview || '';
            }
            if (slot.subLabel.text !== entry.subtitle) {
                slot.subLabel.text = entry.subtitle || '';
            }
            const timeText = formatTime(entry.time);
            if (slot.timeLabel.text !== timeText) {
                slot.timeLabel.text = timeText;
            }

            // 3. 选中态
            if (i === this._selectedIndex) {
                slot.itemBox.add_style_class_name('selected');
            } else {
                slot.itemBox.remove_style_class_name('selected');
            }

            slot.itemBox.show();
        }

        // 隐藏多余的槽位 (若当前页不满 8 条)
        for (let i = pageItems.length; i < this._itemSlots.length; i++) {
            this._itemSlots[i].currentEntry = null;
            this._itemSlots[i].itemBox.hide();
        }

        this._itemActors = this._itemSlots.slice(0, pageItems.length).map(s => s.itemBox);
    }

    _setSelectedIndex(index) {
        const currentEntries = this._getSortedEntries();
        const startIndex = this._currentPage * 8;
        const pageCount = Math.min(8, currentEntries.length - startIndex);
        if (index < 0 || index >= pageCount) return;

        this._selectedIndex = index;
        if (this._itemActors) {
            this._itemActors.forEach((actor, i) => {
                if (i === this._selectedIndex) {
                    actor.add_style_class_name('selected');
                } else {
                    actor.remove_style_class_name('selected');
                }
            });
        }
    }

    _onKeyPress(event) {
        if (this._inSearchMode) {
            const stop = this._onSearchEntryKeyPress(event);
            if (stop === Clutter.EVENT_STOP) {
                return Clutter.EVENT_STOP;
            }
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Page_Up) {
                const currentEntries = this._getSortedEntries();
                const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
                if (totalPages > 1) {
                    const targetPage = (this._currentPage - 1 + totalPages) % totalPages;
                    this._setPage(targetPage, this._selectedIndex);
                }
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Page_Down) {
                const currentEntries = this._getSortedEntries();
                const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
                if (totalPages > 1) {
                    const targetPage = (this._currentPage + 1) % totalPages;
                    this._setPage(targetPage, this._selectedIndex);
                }
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_BackSpace) {
                if (this._searchEntry) {
                    const cur = this._searchEntry.get_text();
                    if (cur.length > 0) {
                        this._searchEntry.set_text(cur.slice(0, -1));
                    }
                }
                return Clutter.EVENT_STOP;
            }
            const char = getPrintableChar(event);
            if (char && this._searchEntry) {
                this._searchEntry.set_text(this._searchEntry.get_text() + char);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        const symbol = event.get_key_symbol();

        // Esc: 关闭弹窗
        if (symbol === Clutter.KEY_Escape) {
            this._closePopup();
            return Clutter.EVENT_STOP;
        }

        const state = typeof event.get_state === 'function' ? event.get_state() : 0;
        const SORT_MODES = ['queue', 'size', 'type', 'initial'];
        const isShift = Boolean(state & Clutter.ModifierType.SHIFT_MASK);

        // Tab / Shift+Tab: 循环切换排序方式 (记录顺序 -> 大小 -> 类型 -> 首字母)
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            const curIdx = SORT_MODES.indexOf(this._sortMode);
            const nextIdx = (isShift || symbol === Clutter.KEY_ISO_Left_Tab)
                ? (curIdx - 1 + SORT_MODES.length) % SORT_MODES.length
                : (curIdx + 1) % SORT_MODES.length;
            this._setSortMode(SORT_MODES[nextIdx]);
            return Clutter.EVENT_STOP;
        }

        // 快捷键关闭 (二次兜底)：若当前按键与设置的 toggle-shortcut 匹配，则关闭弹窗
        if (this._settings) {
            const shortcuts = this._settings.get_strv('toggle-shortcut');
            if (shortcuts && shortcuts.length > 0) {
                const relevantMods = state & (
                    Clutter.ModifierType.CONTROL_MASK |
                    Clutter.ModifierType.MOD1_MASK |
                    Clutter.ModifierType.SHIFT_MASK |
                    Clutter.ModifierType.SUPER_MASK
                );
                if (typeof Meta.accelerator_name === 'function') {
                    const accel = Meta.accelerator_name(relevantMods, symbol);
                    if (accel && shortcuts.some(s => s.toLowerCase() === accel.toLowerCase())) {
                        this._closePopup();
                        return Clutter.EVENT_STOP;
                    }
                }
            }
        }

        // Ctrl+Z: 撤销最近一次删除
        const isCtrl = Boolean(state & Clutter.ModifierType.CONTROL_MASK);
        if (isCtrl && (symbol === Clutter.KEY_z || symbol === Clutter.KEY_Z)) {
            if (this._undoLastDelete()) {
                return Clutter.EVENT_STOP;
            }
        }

        // BackSpace: 删除当前选中的历史记录条目
        if (symbol === Clutter.KEY_BackSpace) {
            const currentEntries = this._getSortedEntries();
            const globalIndex = this._currentPage * 8 + this._selectedIndex;
            if (globalIndex >= 0 && globalIndex < currentEntries.length) {
                this._deleteEntry(currentEntries[globalIndex]);
            }
            return Clutter.EVENT_STOP;
        }

        // Delete 按键: 删除当前选中的历史记录条目
        if (symbol === Clutter.KEY_Delete) {
            const currentEntries = this._getSortedEntries();
            const globalIndex = this._currentPage * 8 + this._selectedIndex;
            if (globalIndex >= 0 && globalIndex < currentEntries.length) {
                this._deleteEntry(currentEntries[globalIndex]);
            }
            return Clutter.EVENT_STOP;
        }

        // Enter / KP_Enter / Space: 确认选中并恢复
        const isConfirmKey = symbol === Clutter.KEY_Return ||
            symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_space;

        if (isConfirmKey) {
            const currentEntries = this._getSortedEntries();
            const totalCount = currentEntries.length;
            const globalIndex = this._currentPage * 8 + this._selectedIndex;
            if (globalIndex >= 0 && globalIndex < totalCount) {
                this._restoreEntry(currentEntries[globalIndex]);
            }
            this._closePopup();
            return Clutter.EVENT_STOP;
        }

        // 方向键与翻页键导航
        const currentEntries = this._getSortedEntries();
        const totalCount = currentEntries.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / 8));
        const startIndex = this._currentPage * 8;
        const pageCount = Math.max(0, Math.min(8, totalCount - startIndex));

        // Up: 上一项 (若在当前页首项，跨页滚动至上一页尾项)
        if (symbol === Clutter.KEY_Up) {
            if (totalCount > 0) {
                if (this._selectedIndex > 0) {
                    this._setSelectedIndex(this._selectedIndex - 1);
                } else if (this._currentPage > 0) {
                    const prevPageCount = 8;
                    this._setPage(this._currentPage - 1, prevPageCount - 1);
                } else if (totalPages > 1) {
                    // 第一页首项循环至末页尾项
                    const lastPage = totalPages - 1;
                    const lastPageCount = totalCount - lastPage * 8;
                    this._setPage(lastPage, lastPageCount - 1);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // Down: 下一项 (若在当前页尾项，跨页滚动至下一页首项)
        if (symbol === Clutter.KEY_Down) {
            if (totalCount > 0) {
                if (this._selectedIndex < pageCount - 1) {
                    this._setSelectedIndex(this._selectedIndex + 1);
                } else if (this._currentPage < totalPages - 1) {
                    this._setPage(this._currentPage + 1, 0);
                } else if (totalPages > 1) {
                    // 末页尾项循环至第一页首项
                    this._setPage(0, 0);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // Left / PageUp: 翻至上一页 (循环翻页：第一页向上翻至末页)
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Page_Up) {
            if (totalPages > 1) {
                const targetPage = (this._currentPage - 1 + totalPages) % totalPages;
                this._setPage(targetPage, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // Right / PageDown: 翻至下一页 (循环翻页：末页向下翻至首页)
        if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Page_Down) {
            if (totalPages > 1) {
                const targetPage = (this._currentPage + 1) % totalPages;
                this._setPage(targetPage, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // 字符输入：键入任何文字时自动出现替代排序选项卡
        const char = getPrintableChar(event);
        if (char) {
            this._enterSearchMode(char);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }
}
