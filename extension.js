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

// 格式化数据容量大小 (B / KB / MB)
export function formatByteSize(size) {
    if (typeof size !== 'number' || size < 0) return '0 B';
    return size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` :
           size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
}

// 格式化记录复制时间 (当天显示 HH:mm:ss，跨天显示 n天前 HH:mm / nd ago HH:mm)
export function formatTime(timestamp, lang = 'zh-CN') {
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
    const isEn = lang === 'en-US';
    return isEn ? `${diffDays}d ago ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${diffDays}天前 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

export const MAX_SEARCH_QUERY_LEN = 128;
export const MAX_SEARCH_IMPORT_LEN = 64;

// 核心 MIME 检测规则
// 纯内存暂存：不屏蔽密码等类型，保留原始字节流
export function detectCoreMime(mimeTypes) {
    if (!mimeTypes || mimeTypes.length === 0) return null;

    // 1. 位图图片类（支持常见位图缩略图预览：PNG, JPEG, WebP, BMP, GIF；SVG 等矢量格式作为未知类型仅保留原始数据）
    const imgMime = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'].find(m => mimeTypes.includes(m));
    if (imgMime) {
        return { mime: imgMime, type: 'image' };
    }

    // 2. 文件列表 (Nautilus, Nemo 等 GNOME 原生文件管理器)
    // 优先读取 x-special/gnome-copied-files 以便精准识别 copy 或 cut（剪切）动作标记
    const fileMime = ['x-special/gnome-copied-files', 'text/uri-list'].find(m => mimeTypes.includes(m));
    if (fileMime) {
        return { mime: fileMime, type: 'files' };
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

    // 4. 单一纯文本（包括用户与密码管理器复制的密码字符串、Token 等）
    if (textMime) {
        return { mime: textMime, type: 'text' };
    }

    // 5. 单一富文本 HTML
    if (hasHtml) {
        return { mime: 'text/html', type: 'html' };
    }

    // 6. 兜底其它任意合法的 Raw 二进制未知类型（包含 SVG、Office类软件专有类型等，任何情况下都不能预览，原样展示类型标签）
    const valid = mimeTypes.filter(m => !m.startsWith('TARGETS') && !m.startsWith('TIMESTAMP') && !m.startsWith('MULTIPLE'));
    if (valid.length > 0) {
        return { mime: valid[0], type: 'raw' };
    }

    return null;
}

/**
 * 识别文件操作是否为剪切 (Cut) 动作。
 * 目前专注于 GNOME 原生文件管理器 Nautilus（识别 x-special/gnome-copied-files 与 text/uri-list 首行的 cut 标记）。
 * 做好抽象接口，后续若需扩展其他桌面环境可在此处统一拓展。
 */
export function isFileCutOperation(gBytes) {
    if (!gBytes || gBytes.get_size() === 0) return false;
    try {
        const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
        const rawHead = stream.read_bytes(100, null);
        const data = rawHead.get_data ? rawHead.get_data() : (rawHead.toArray ? rawHead.toArray() : rawHead);
        const str = Utf8Decoder.decode(data);
        const lines = str.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        const action = lines[0]?.toLowerCase();
        return action === 'cut' || lines.includes('cut');
    } catch (_) {
        return false;
    }
}

/**
 * 统一流式提取前缀预览文本。
 * 采用 64KB 单次分块按需流式提取，最多 10 次循环（上限 640KB），用 .trim() 剥离前导空文本，
 * 杜绝大文本或复合类型条目全量 decode 数十 MB 文本的 CPU 与内存浪费。
 */
export function extractTextPreview(gBytes, isHtml = false) {
    if (!gBytes || gBytes.get_size() === 0) return '';
    try {
        const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
        const CHUNK_SIZE = 64 * 1024; // 64KB (65536 字节)
        let text = '';
        let clean = '';
        for (let attempt = 0; attempt < 10; attempt++) {
            const chunk = stream.read_bytes(CHUNK_SIZE, null);
            if (!chunk || chunk.get_size() === 0) break;
            const data = chunk.get_data ? chunk.get_data() : (chunk.toArray ? chunk.toArray() : chunk);
            const rawChunk = Utf8Decoder.decode(data);
            text += rawChunk;
            const rawProcessed = isHtml ? text.replace(/<[^>]+>/g, ' ') : text;
            clean = rawProcessed.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
            if (clean) break;
        }
        return clean;
    } catch (_) {
        return '';
    }
}

// 根据类型和原始字节生成界面显示的简短摘要
// 关键设计准则：
// 1. 一个条目是否能预览，取决于能不能以文本形式显示；
// 2. 类型严格按照它自身，不能串味到其他类型；
// 3. 我们只维护有限的类型预览（文本、富文本、文件列表、位图）；
// 4. 未知类型（统一复合类型，包含 SVG、Office专有类型等任何不能预览的类型）在原本展示预览文本的地方展示未知类型的类型标签字符串；
// 5. 且只有位图（PNG/JPEG/WebP/BMP/GIF）能以缩略图形式预览。
function generatePreview(type, mime, gBytes, unknownTypeName = null, lang = 'zh-CN', extra = null) {
    const size = gBytes.get_size();
    const sizeStr = formatByteSize(size);
    const isEn = lang === 'en-US';

    // 0. 复合类型 (多 MIME：优先提取纯文本流进行文本预览，保留富文本与纯文本双格式)
    if (type === 'composite') {
        let clean = '';
        if (extra && extra.textBytes) {
            clean = extractTextPreview(extra.textBytes, false);
        }
        if (!clean) {
            const textPart = extractCompositePart(gBytes, m => m.startsWith('text/plain') || m.includes('STRING'));
            if (textPart) {
                clean = extractTextPreview(textPart, false);
            }
        }
        if (!clean) {
            const htmlPart = (extra && extra.htmlBytes) ? extra.htmlBytes : extractCompositePart(gBytes, m => m.startsWith('text/html') || m.includes('html'));
            if (htmlPart) {
                clean = extractTextPreview(htmlPart, true);
            }
        }
        return {
            title: clean.length > 1000 ? `${clean.slice(0, 1000)}…` : (clean || (isEn ? '(Empty text)' : '(空文本)')),
            subtitle: `${isEn ? 'Multi-type' : '多类型'} · ${sizeStr}`,
            icon: 'text-html-symbolic',
        };
    }

    // 1. 文本类 (纯文本、富文本 HTML 等)：通过统一 64KB 流式按需提取前缀
    // 准则：只要能以文本形式显示，就提取前缀文本作为预览；若全是控制字符/乱码无法以文本形式显示，则只显示类型本身
    if (type === 'text' || type === 'html') {
        const clean = extractTextPreview(gBytes, false);
        return {
            title: clean.length > 1000 ? `${clean.slice(0, 1000)}…` : (clean || (isEn ? '(Empty text)' : '(空文本)')),
            subtitle: `${type === 'html' ? (isEn ? 'HTML' : '富文本') : (isEn ? 'Text' : '文本')} · ${sizeStr}`,
            icon: type === 'html' ? 'text-html-symbolic' : 'edit-copy-symbolic',
        };
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
                    title: isEn ? 'File List' : '文件列表',
                    subtitle: isEn ? 'Files · 0 items (path only, no disk read)' : '文件 · 0 项 (仅存路径，不读内容)',
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
                if (l.endsWith('/') || l.endsWith('\\')) dirCount++;
            }

            const isAllDir = dirCount === totalCount;
            const isMixed = dirCount > 0 && !isAllDir;
            const icon = dirCount > 0 ? 'folder-symbolic' : 'text-x-generic-symbolic';
            const label = isAllDir ? (isEn ? 'Folders' : '文件夹') : (isMixed ? (isEn ? 'Files/Folders' : '文件/目录') : (isEn ? 'Files' : '文件'));
            const countStr = isCapped ? `${totalCount}+` : `${totalCount}`;
            const suffix = isAllDir ? (isEn ? `and ${countStr} folders` : `等 ${countStr} 个文件夹`) : (isMixed ? (isEn ? `and ${countStr} items` : `等 ${countStr} 项`) : (isEn ? `and ${countStr} files` : `等 ${countStr} 个文件`));

            const title = totalCount === 1 ? name1 :
                          totalCount === 2 ? `${name1}, ${name2}` :
                          `${name1}, ${name2} ${suffix}`;

            return {
                title,
                subtitle: isEn ? `${label} · ${countStr} items (path only, no disk read)` : `${label} · ${countStr} 项 (仅存路径，不读内容)`,
                icon,
            };
        } catch (_e) {
            // 异常兜底：严格按照自身类型显示，绝不串味成 folder 图标
            return {
                title: isEn ? `File List (${sizeStr})` : `文件列表 (${sizeStr})`,
                subtitle: mime,
                icon: 'text-x-generic-symbolic',
            };
        }
    }

    // 3. 位图类 (严格仅限位图格式：不能以文本形式显示，不显示文本预览；且只有位图能以缩略图形式预览)
    if (type === 'image') {
        return {
            title: isEn ? `Image (${sizeStr})` : `图片 (${sizeStr})`,
            subtitle: mime,
            icon: 'image-x-generic-symbolic',
        };
    }

    // 4. 其余未知类型（统一复合类型，包含 SVG、Office专有类型等任何不能预览的类型）：
    // 严格不解析预览内容，在原本展示预览文本的地方展示未知类型的类型标签字符串
    const tag = mime || unknownTypeName || (isEn ? 'Unknown Type' : '未知类型');
    return {
        title: tag.length > 200 ? `${tag.slice(0, 200)}…` : tag,
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

/**
 * 将多 MIME 复合部件打包为自包含的确定性二进制数据流 (CMP1 容器格式)
 * 完全在内存中构建，不落地磁盘、无进程调用
 */
export function packCompositeBytes(parts) {
    const encoder = new TextEncoder();
    const out = Gio.MemoryOutputStream.new_resizable();
    // Magic: CMP1 (4 字节: 0x43, 0x4D, 0x50, 0x31)
    const magic = new Uint8Array([0x43, 0x4D, 0x50, 0x31]);
    out.write_bytes(new GLib.Bytes(magic), null);
    const countBuf = new Uint8Array(2);
    new DataView(countBuf.buffer).setUint16(0, parts.length, false);
    out.write_bytes(new GLib.Bytes(countBuf), null);

    for (const part of parts) {
        const mimeBytes = encoder.encode(part.mime);
        const header = new Uint8Array(6);
        const dv = new DataView(header.buffer);
        dv.setUint16(0, mimeBytes.length, false);
        dv.setUint32(2, part.bytes.get_size(), false);

        out.write_bytes(new GLib.Bytes(header.subarray(0, 2)), null);
        out.write_bytes(new GLib.Bytes(mimeBytes), null);
        out.write_bytes(new GLib.Bytes(header.subarray(2, 6)), null);
        out.write_bytes(part.bytes, null);
    }
    out.close(null);
    return out.steal_as_bytes();
}

/**
 * 从自包含二进制 CMP1 容器流解析还原多 MIME 复合部件列表
 */
export function unpackCompositeBytes(gBytes) {
    if (!gBytes || gBytes.get_size() < 6) return [];
    const uData = gBytes.get_data();
    if (uData[0] !== 0x43 || uData[1] !== 0x4D || uData[2] !== 0x50 || uData[3] !== 0x31) {
        return [];
    }
    const dv = new DataView(uData.buffer, uData.byteOffset, uData.byteLength);
    const count = dv.getUint16(4, false);
    let offset = 6;
    const parts = [];
    for (let i = 0; i < count; i++) {
        if (offset + 2 > uData.length) break;
        const mimeLen = dv.getUint16(offset, false);
        offset += 2;
        if (offset + mimeLen > uData.length) break;
        const mime = Utf8Decoder.decode(uData.subarray(offset, offset + mimeLen));
        offset += mimeLen;
        if (offset + 4 > uData.length) break;
        const dataLen = dv.getUint32(offset, false);
        offset += 4;
        if (offset + dataLen > uData.length) break;
        const partBytes = makeSliceBytes(gBytes, uData, offset, dataLen);
        offset += dataLen;
        parts.push({ mime, bytes: partBytes });
    }
    return parts;
}

/**
 * 从自包含二进制 CMP1 容器流中按需提取指定 MIME 的部件切片，避免全量解包与无用数据物化
 * @param {GLib.Bytes} gBytes 
 * @param {string|Function} targetMime 目标 MIME 字符串或匹配函数
 * @returns {GLib.Bytes|null}
 */
export function extractCompositePart(gBytes, targetMime) {
    if (!gBytes || gBytes.get_size() < 6) return null;
    const uData = gBytes.get_data ? gBytes.get_data() : (gBytes.toArray ? gBytes.toArray() : gBytes);
    if (uData[0] !== 0x43 || uData[1] !== 0x4D || uData[2] !== 0x50 || uData[3] !== 0x31) {
        return null;
    }
    const dv = new DataView(uData.buffer, uData.byteOffset, uData.byteLength);
    const count = dv.getUint16(4, false);
    let offset = 6;
    for (let i = 0; i < count; i++) {
        if (offset + 2 > uData.length) break;
        const mimeLen = dv.getUint16(offset, false);
        offset += 2;
        if (offset + mimeLen > uData.length) break;
        const mime = Utf8Decoder.decode(uData.subarray(offset, offset + mimeLen));
        offset += mimeLen;
        if (offset + 4 > uData.length) break;
        const dataLen = dv.getUint32(offset, false);
        offset += 4;
        if (offset + dataLen > uData.length) break;
        const isMatch = (typeof targetMime === 'function')
            ? targetMime(mime)
            : (mime === targetMime || mime.startsWith(targetMime));
        if (isMatch) {
            return makeSliceBytes(gBytes, uData, offset, dataLen);
        }
        offset += dataLen;
    }
    return null;
}

export class RadixNode {
    constructor(bytes = null, parent = null) {
        this.bytes = bytes;
        this.parent = parent;
        this.children = new Map(); // byte (0-255) -> RadixNode
        this.entries = new Map();  // mime -> entry (允许不同 MIME 条目零冗余物理共享同一前缀/叶子节点)
        this.entry = null;
    }

    get data() {
        return this.bytes ? this.bytes.get_data() : null;
    }

    setBytes(bytes) {
        this.bytes = bytes;
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
    #mimeEntryCounts = new Map();

    constructor() {
        this._root = new RadixNode(null, null); // 统一全局前缀树根节点，单类型与多类型数据统一存储查重
        this._roots = new Map(); // 兼容性 MIME 注册表: mime -> this._root
    }

    get root() {
        return this._root;
    }

    _getRoot(mime) {
        if (!this._roots.has(mime)) {
            this._roots.set(mime, this._root);
        }
        return this._root;
    }

    hasRoot(mime) {
        return this._roots.has(mime);
    }

    getRoot(mime) {
        return this._roots.has(mime) ? this._root : null;
    }

    get rootCount() {
        return this._roots.size;
    }

    getNode(entry) {
        if (!entry) return null;
        return this.#nodeByEntry.get(entry) || entry._radixNode || null;
    }

    insert(mime, gBytes, entryBuilder) {
        if (mime) {
            this._roots.set(mime, this._root);
        }
        const mimeKey = mime || 'default';
        const root = this._root;
        const totalLen = gBytes.get_size();
        const uIncoming = gBytes.get_data();
        let currNode = root;
        let offset = 0;

        const onInserted = (entry) => {
            const count = this.#mimeEntryCounts.get(mimeKey) || 0;
            this.#mimeEntryCounts.set(mimeKey, count + 1);
            return entry;
        };

        while (true) {
            const remainingLen = totalLen - offset;
            if (remainingLen === 0) {
                if (currNode.entries.has(mimeKey)) {
                    return { isDuplicate: true, existingEntry: currNode.entries.get(mimeKey) };
                }
                const entry = entryBuilder(currNode);
                currNode.entries.set(mimeKey, entry);
                currNode.entry = entry;
                this.#nodeByEntry.set(entry, currNode);
                onInserted(entry);
                return { isDuplicate: false, newEntry: entry };
            }

            const firstByte = uIncoming[offset];
            if (!currNode.children.has(firstByte)) {
                const leafBytes = makeSliceBytes(gBytes, uIncoming, offset, remainingLen);
                const leaf = new RadixNode(leafBytes, currNode);
                const entry = entryBuilder(leaf);
                leaf.entries.set(mimeKey, entry);
                leaf.entry = entry;
                this.#nodeByEntry.set(entry, leaf);
                currNode.children.set(firstByte, leaf);
                onInserted(entry);
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
                splitNode.entries.set(mimeKey, entry);
                splitNode.entry = entry;
                this.#nodeByEntry.set(entry, splitNode);
                onInserted(entry);
                return { isDuplicate: false, newEntry: entry };
            } else {
                const newSuffixBytes = makeSliceBytes(gBytes, uIncoming, offset, totalLen - offset);
                const newLeaf = new RadixNode(newSuffixBytes, splitNode);
                const entry = entryBuilder(newLeaf);
                newLeaf.entries.set(mimeKey, entry);
                newLeaf.entry = entry;
                this.#nodeByEntry.set(entry, newLeaf);
                splitNode.children.set(uIncoming[offset], newLeaf);
                onInserted(entry);
                return { isDuplicate: false, newEntry: entry };
            }
        }
    }

    remove(entry) {
        if (!entry) return;
        const node = this.#nodeByEntry.get(entry) || entry._radixNode;
        if (!node) return;
        this.#nodeByEntry.delete(entry);
        if (entry.mime) {
            const count = this.#mimeEntryCounts.get(entry.mime) || 1;
            if (count <= 1) {
                this.#mimeEntryCounts.delete(entry.mime);
                this._roots.delete(entry.mime);
            } else {
                this.#mimeEntryCounts.set(entry.mime, count - 1);
            }
        }
        if (node.entries) {
            if (entry.mime) {
                node.entries.delete(entry.mime);
            } else {
                for (const [m, e] of node.entries.entries()) {
                    if (e === entry) {
                        node.entries.delete(m);
                        break;
                    }
                }
            }
            if (node.entries.size === 0) {
                node.entry = null;
            } else {
                node.entry = node.entries.values().next().value;
            }
        } else {
            node.entry = null;
        }

        const tryCollapse = (n) => {
            if (!n || !n.parent) return;
            const hasEntries = (n.entries && n.entries.size > 0) || n.entry;
            if (!hasEntries && n.children.size === 1) {
                const [, onlyChild] = n.children.entries().next().value;
                const out = Gio.MemoryOutputStream.new_resizable();
                out.write_bytes(n.bytes, null);
                out.write_bytes(onlyChild.bytes, null);
                out.close(null);
                const mergedBytes = out.steal_as_bytes();

                onlyChild.setBytes(mergedBytes);
                onlyChild.parent = n.parent;
                const parentFirstByte = n.data[0];
                n.parent.children.set(parentFirstByte, onlyChild);

                tryCollapse(n.parent);
            }
        };

        let curr = node;
        while (curr && curr.parent && curr.children.size === 0 && (!curr.entries || curr.entries.size === 0) && !curr.entry) {
            const parent = curr.parent;
            const firstByte = curr.data[0];
            parent.children.delete(firstByte);
            curr = parent;
        }

        if (curr) {
            tryCollapse(curr);
        }
    }

    getTotalBytes() {
        let total = 0;
        const stack = [this._root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.bytes && typeof node.bytes.get_size === 'function') {
                total += node.bytes.get_size();
            }
            for (const child of node.children.values()) {
                stack.push(child);
            }
        }
        return total;
    }

    clear() {
        this._root = new RadixNode(null, null);
        this._roots.clear();
        this.#mimeEntryCounts.clear();
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
    // 追踪所有活跃定时器 ID，支持 disable() 同步统一清理
    #activeTimerIds = new Set();
    // 未知类型按元数据 raw 格式映射表 (mime -> '未知类型N')
    #unknownTypes = new Map();
    // 缓存条目预览文本的 MD5 摘要 (entry -> 8位 MD5 字符串，不清缓存，WeakMap 随条目生命周期自动释放)
    #previewMd5ByEntry = new WeakMap();
    // 当前在途异步读取专属 Cancellable（用于抢占中断旧源）
    _currentReadCancellable = null;
    // 撤销栈 (LIFO 记录软删除条目)
    _undoStack = [];

    _inSearchMode = false;
    _searchQuery = '';
    _searchBar = null;
    _searchEntry = null;
    _contextMenu = null;

    get inSearchMode() {
        return this._inSearchMode;
    }

    get searchQuery() {
        return this._searchQuery;
    }

    _isTextPreviewable(entry) {
        if (!entry) return false;
        // 未知类型实际上是以类型标签的文本形式预览，统一对待可见预览的内容；全系统中唯独位图图片以缩略图预览
        return entry.type !== 'image';
    }

    _addTimeout(intervalMs, callback, priority = GLib.PRIORITY_DEFAULT) {
        let id = 0;
        id = GLib.timeout_add(priority, intervalMs, () => {
            this.#activeTimerIds.delete(id);
            return callback();
        });
        if (id > 0) {
            this.#activeTimerIds.add(id);
        }
        return id;
    }

    _removeTimeout(id) {
        if (id > 0) {
            GLib.source_remove(id);
            this.#activeTimerIds.delete(id);
        }
    }

    _getLanguage() {
        try {
            if (this._settings && this._settings.settings_schema && this._settings.settings_schema.has_key('ui-language')) {
                return this._settings.get_string('ui-language') || 'zh-CN';
            }
        } catch (_) {}
        return 'zh-CN';
    }

    _formatTime(timestamp) {
        return formatTime(timestamp, this._getLanguage());
    }

    _getSearchPlaceholder() {
        return this._getLanguage() === 'en-US' ? 'Search previews...' : '搜索预览内容...';
    }

    _getEmptyText() {
        const isEn = this._getLanguage() === 'en-US';
        return this._inSearchMode ?
            (isEn ? 'No matching items' : '无匹配项目') :
            (isEn ? 'Clipboard history is empty' : '剪贴板历史为空');
    }

    _getEntrySubtitle(entry) {
        if (!entry) return '';
        const isEn = this._getLanguage() === 'en-US';
        if (entry.type === 'composite') {
            const sizeStr = formatByteSize(entry.size);
            const typeStr = isEn ? 'Multi-type' : '多类型';
            return `${typeStr} · ${sizeStr}`;
        }
        if (!entry.type || entry.type === 'text' || entry.type === 'html') {
            const sizeStr = formatByteSize(entry.size);
            const typeStr = entry.type === 'html' ? (isEn ? 'HTML' : '富文本') : (isEn ? 'Text' : '文本');
            return `${typeStr} · ${sizeStr}`;
        }
        if (entry.type === 'image') {
            return entry.mime || '';
        }
        if (entry.type === 'files') {
            if (isEn) {
                return (entry.subtitle || '')
                    .replace('文件夹', 'Folders')
                    .replace('文件/目录', 'Files/Folders')
                    .replace('文件', 'Files')
                    .replace('项 (仅存路径，不读内容)', 'items (path only, no disk read)');
            }
            return (entry.subtitle || '')
                .replace('Folders', '文件夹')
                .replace('Files/Folders', '文件/目录')
                .replace('Files', '文件')
                .replace('items (path only, no disk read)', '项 (仅存路径，不读内容)');
        }
        if (entry.type === 'unknown' || entry.type === 'raw') {
            return formatByteSize(entry.size);
        }
        return entry.subtitle || '';
    }

    _getEntryPreview(entry) {
        if (!entry) return '';
        const isEn = this._getLanguage() === 'en-US';
        if (entry.type === 'image') {
            return isEn ? `Image (${formatByteSize(entry.size)})` : `图片 (${formatByteSize(entry.size)})`;
        }
        if (entry.type === 'files') {
            if (isEn) {
                if (entry.preview === '文件列表') return 'File List';
                if (entry.preview && entry.preview.startsWith('文件列表 (')) {
                    return `File List (${formatByteSize(entry.size)})`;
                }
                return (entry.preview || '')
                    .replace(/等\s*(\d+\+?)\s*个文件夹/, 'and $1 folders')
                    .replace(/等\s*(\d+\+?)\s*项/, 'and $1 items')
                    .replace(/等\s*(\d+\+?)\s*个文件/, 'and $1 files');
            }
            if (entry.preview === 'File List') return '文件列表';
            if (entry.preview && entry.preview.startsWith('File List (')) {
                return `文件列表 (${formatByteSize(entry.size)})`;
            }
            return (entry.preview || '')
                .replace(/and\s*(\d+\+?)\s*folders/, '等 $1 个文件夹')
                .replace(/and\s*(\d+\+?)\s*items/, '等 $1 项')
                .replace(/and\s*(\d+\+?)\s*files/, '等 $1 个文件');
        }
        if (entry.type === 'unknown' || entry.type === 'raw') {
            if (isEn && entry.preview === '未知类型') {
                return 'Unknown Type';
            }
            if (!isEn && entry.preview === 'Unknown Type') {
                return '未知类型';
            }
            return entry.preview || entry.mime || (isEn ? 'Unknown Type' : '未知类型');
        }
        if (isEn && entry.preview === '(空文本)') {
            return '(Empty text)';
        }
        if (!isEn && entry.preview === '(Empty text)') {
            return '(空文本)';
        }
        return entry.preview || '';
    }

    _applyLanguage() {
        if (this._contextMenu) {
            this._closeContextMenu();
        }
        const isEn = this._getLanguage() === 'en-US';
        if (this._sortButtons) {
            const labels = {
                queue: isEn ? 'Order' : '记录顺序',
                size: isEn ? 'Size' : '大小',
                type: isEn ? 'Type' : '类型',
                initial: isEn ? 'A-Z' : '首字母',
            };
            for (const [id, btn] of this._sortButtons) {
                if (btn._labelActor) {
                    btn._labelActor.text = labels[id] || id;
                }
            }
        }
        if (this._searchEntry && (!this._searchQuery || this._searchQuery.length === 0)) {
            this._searchEntry.set_text(this._getSearchPlaceholder());
        }
        if (this._undoLabel) {
            this._undoLabel.text = isEn ? 'Undo' : '撤销';
        }
        this._updatePageBadge();
        this._renderPage();
    }

    _updateSearchDisplay() {
        if (!this._searchEntry) return;
        if (this._searchQuery && this._searchQuery.length > 0) {
            this._searchEntry.set_text(this._searchQuery);
            this._searchEntry.remove_style_class_name('hint');
        } else {
            this._searchEntry.set_text(this._getSearchPlaceholder());
            this._searchEntry.add_style_class_name('hint');
        }
    }

    _enterSearchMode(initialChar = '') {
        this._loopArmDirection = null;
        this._inSearchMode = true;
        this._searchQuery = (initialChar || '').slice(0, MAX_SEARCH_QUERY_LEN);
        if (this._sortBar) this._sortBar.hide();
        if (this._searchBar) this._searchBar.show();
        this._updateSearchDisplay();
        this._currentPage = 0;
        this._selectedIndex = 0;
        this._renderPage();
        this._updatePageBadge();
    }

    _exitSearchMode() {
        if (!this._inSearchMode) return;
        this._loopArmDirection = null;
        this._inSearchMode = false;
        this._searchQuery = '';
        if (this._searchEntry) {
            this._searchEntry.set_text('');
            this._searchEntry.remove_style_class_name('hint');
        }
        if (this._searchBar) this._searchBar.hide();
        if (this._sortBar) this._sortBar.show();
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
                const displayPreview = this._getEntryPreview(entry).toLowerCase();
                return preview.includes(query) || displayPreview.includes(query);
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
            const typeRank = { 'text': 1, 'composite': 2, 'html': 3, 'files': 4, 'image': 5, 'raw': 6 };
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
        this._loopArmDirection = null;
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
        // 日志关闭时直接短路返回，不进行任何 MD5 计算，消除 CPU 开销
        if (!this._isLoggingEnabled()) return '';
        const id = entry.id || 'unknown';
        const type = entry.type || 'unknown';
        const size = typeof entry.size === 'number' ? entry.size : (entry.bytes?.get_size ? entry.bytes.get_size() : 0);

        // 不展示内容文本预览的项目（位图、未知类型等）或无预览内容的不计算且不打印 MD5
        if (entry.type === 'image' || entry.type === 'raw' || !entry.preview) {
            return `[条目#${id} (${type}, ${size}B)]`;
        }

        // 仅计算预览文本的前 8 位 MD5，并写入 WeakMap 缓存；日志开关切换或日常运行时不清已有缓存
        let md5 = null;
        try {
            md5 = this.#previewMd5ByEntry.get(entry);
        } catch (_e) {}
        if (!md5) {
            try {
                md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, entry.preview, -1).slice(0, 8);
                try {
                    this.#previewMd5ByEntry.set(entry, md5);
                } catch (_e) {}
            } catch (_e) {
                md5 = 'none';
            }
        }
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
        return mime || (this._getLanguage() === 'en-US' ? 'Unknown Type' : '未知类型');
    }

    get unknownTypes() {
        const map = new Map();
        for (const item of this.#history) {
            if (item.type === 'raw' && item.mime) {
                map.set(item.mime, item.mime);
            }
        }
        return map;
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
        this._langChangedId = -1;
        this._undoLabel = null;

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

        // 监听界面语言修改事件，弹窗在位实时切换语言
        this._langChangedId = this._settings.connect(
            'changed::ui-language',
            () => {
                if (this._container) {
                    this._applyLanguage();
                }
            }
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

        // 3. 取消任何挂起的 UI idle 刷新与活跃定时器
        if (this._renderIdleId) {
            GLib.source_remove(this._renderIdleId);
            this._renderIdleId = 0;
        }
        for (const timerId of this.#activeTimerIds) {
            try {
                GLib.source_remove(timerId);
            } catch (_) {}
        }
        this.#activeTimerIds.clear();

        // 4. 断开设置监听
        if (this._settings) {
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

            if (this._langChangedId >= 0) {
                this._settings.disconnect(this._langChangedId);
                this._langChangedId = -1;
            }
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

        // 6. 立即同步销毁弹窗与全部 UI / 槽位引用（彻底切断槽位对 entry 的引用闭包，允许 GC 即时回收）
        this._destroyPopupUI();
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

    async _readMimeStream(selectionSource, mime, readCancellable, resetWatchdog, maxPayloadBytes, currentTotalRead = 0) {
        let inputStream = null;
        let outputStream = null;
        let isOversized = false;
        try {
            inputStream = await callAsync(selectionSource, 'read_async', 'read_finish', mime, readCancellable);
            resetWatchdog();

            outputStream = Gio.MemoryOutputStream.new_resizable();
            const CHUNK_SIZE = 64 * 1024;
            let totalRead = currentTotalRead;

            while (true) {
                if (readCancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) break;

                const bytes = await callAsync(inputStream, 'read_bytes_async', 'read_bytes_finish', CHUNK_SIZE, GLib.PRIORITY_DEFAULT, readCancellable);
                const chunkSize = bytes.get_size();
                if (chunkSize === 0) break; // EOF

                totalRead += chunkSize;
                this._debug(`[RawClipboard] 收到数据块 (${mime}): ${chunkSize} 字节，累计已读: ${totalRead} 字节`);
                if (totalRead > maxPayloadBytes) {
                    isOversized = true;
                    readCancellable.cancel();
                    break;
                }

                outputStream.write_bytes(bytes, null);
                resetWatchdog();
            }

            if (isOversized) {
                return { isOversized: true, bytes: null };
            }

            outputStream.close(null);
            return { isOversized: false, bytes: outputStream.steal_as_bytes() };
        } finally {
            if (inputStream) {
                try { inputStream.close(null); } catch (_) {}
            }
            if (outputStream && !outputStream.is_closed()) {
                try { outputStream.close(null); } catch (_) {}
            }
        }
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

        // 绑定创建时的 settings 与 cancellable，确保生命周期成对释放，杜绝跨代污染
        const boundSettings = this._settings;
        const boundCancellable = this._cancellable;

        let parentCancelId = 0;
        let watchdogId = 0;
        let overallTimeoutId = 0;
        let overallSettingsChangedId = 0;
        const overallStartTime = Date.now();

        try {
            if (boundCancellable) {
                parentCancelId = boundCancellable.connect(() => {
                    readCancellable.cancel();
                });
            }

            let inactivityTimeoutMs = INACTIVITY_TIMEOUT_MS;
            let overallTimeoutMs = OVERALL_TIMEOUT_MS;

            if (boundSettings) {
                try {
                    const schema = boundSettings.settings_schema;
                    if (!schema || schema.has_key('inactivity-timeout-sec')) {
                        const sec = boundSettings.get_int('inactivity-timeout-sec');
                        if (sec > 0) inactivityTimeoutMs = sec * 1000;
                    }
                } catch (_) {}
                try {
                    const schema = boundSettings.settings_schema;
                    if (!schema || schema.has_key('overall-timeout-sec')) {
                        const sec = boundSettings.get_int('overall-timeout-sec');
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
            // 支持动态感知设置项更新：每次重置看门狗时读取最新配置
            const resetWatchdog = () => {
                if (watchdogId > 0) {
                    this._removeTimeout(watchdogId);
                    watchdogId = 0;
                }
                if (this._inactivityTimeoutMs !== undefined) {
                    inactivityTimeoutMs = this._inactivityTimeoutMs;
                } else if (boundSettings) {
                    try {
                        const schema = boundSettings.settings_schema;
                        if (!schema || schema.has_key('inactivity-timeout-sec')) {
                            const sec = boundSettings.get_int('inactivity-timeout-sec');
                            if (sec > 0) inactivityTimeoutMs = sec * 1000;
                        }
                    } catch (_) {}
                }
                watchdogId = this._addTimeout(inactivityTimeoutMs, () => {
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
                    this._removeTimeout(overallTimeoutId);
                    overallTimeoutId = 0;
                }
                const elapsedMs = Date.now() - overallStartTime;
                if (elapsedMs >= timeoutMs) {
                    this._warn(`[RawClipboard] 总体传输超时生效：当前已用时间 (${elapsedMs}ms) 已超出限制 (${timeoutMs}ms)，立即取消当前读取`);
                    readCancellable.cancel();
                    return;
                }
                const remainingMs = timeoutMs - elapsedMs;
                overallTimeoutId = this._addTimeout(remainingMs, () => {
                    overallTimeoutId = 0;
                    this._warn(`[RawClipboard] 触发单次抓取总体硬超时 (达 ${timeoutMs}ms 上限)，中止并丢弃当前读取`);
                    readCancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });
            };

            scheduleOverallTimeout(overallTimeoutMs);

            if (boundSettings) {
                try {
                    overallSettingsChangedId = boundSettings.connect('changed::overall-timeout-sec', () => {
                        try {
                            const sec = boundSettings.get_int('overall-timeout-sec');
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
            // 动态读取单条数据上限（MB），支持从 5MB 到 1024MB（最大 1GB）
            const maxMb = this._settings ? this._settings.get_int('max-size-mb') : 50;
            const maxPayloadBytes = Math.max(5, Math.min(1024, maxMb)) * 1024 * 1024;

            let gBytes = null;
            let size = 0;
            let compositeTextBytes = null;
            let compositeHtmlBytes = null;
            let compositeParts = null;

            if (core.type === 'composite') {
                this._debug(`[RawClipboard] 开始异步拉取复合类型数据流 (${core.htmlMime} + ${core.textMime}, 单条上限: ${maxMb}MB)...`);
                const htmlRes = await this._readMimeStream(selectionSource, core.htmlMime, readCancellable, resetWatchdog, maxPayloadBytes, 0);
                if (htmlRes.isOversized) {
                    this._warn(`[RawClipboard] 提前熔断拦截超限剪贴板数据 (已超过上限 ${maxMb} MB)`);
                    return;
                }
                const htmlBytes = htmlRes.bytes;
                if (!htmlBytes || htmlBytes.get_size() === 0) return;

                const textRes = await this._readMimeStream(selectionSource, core.textMime, readCancellable, resetWatchdog, maxPayloadBytes, htmlBytes.get_size());
                if (textRes.isOversized) {
                    this._warn(`[RawClipboard] 提前熔断拦截超限剪贴板数据 (已超过上限 ${maxMb} MB)`);
                    return;
                }
                const textBytes = textRes.bytes || new GLib.Bytes(new Uint8Array(0));

                if (readCancellable.is_cancelled() || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                    this._log('[RawClipboard] 读取守卫命中（停滞超时/总耗时超限/所有者易手），彻底丢弃数据不入库');
                    return;
                }

                compositeHtmlBytes = htmlBytes;
                compositeTextBytes = textBytes;
                compositeParts = [
                    { mime: core.htmlMime, bytes: htmlBytes },
                    { mime: core.textMime, bytes: textBytes },
                ];
                gBytes = packCompositeBytes(compositeParts);
                size = htmlBytes.get_size() + textBytes.get_size();
            } else {
                this._debug(`[RawClipboard] 开始异步拉取数据流 (${core.mime}, 单条上限: ${maxMb}MB, 停滞超时: ${inactivityTimeoutMs}ms, 总超时: ${overallTimeoutMs}ms)...`);
                const res = await this._readMimeStream(selectionSource, core.mime, readCancellable, resetWatchdog, maxPayloadBytes, 0);
                if (res.isOversized) {
                    this._warn(`[RawClipboard] 提前熔断拦截超限剪贴板数据 (已超过上限 ${maxMb} MB)`);
                    return;
                }

                if (readCancellable.is_cancelled() || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                    this._log('[RawClipboard] 读取守卫命中（停滞超时/总耗时超限/所有者易手），彻底丢弃数据不入库');
                    return;
                }

                gBytes = res.bytes;
                if (!gBytes || gBytes.get_size() === 0) return;
                size = gBytes.get_size();
            }

            this._debug(`[RawClipboard] 数据流读取完毕，总大小: ${size} 字节`);

            // 严格识别与拦截“剪切文件”操作 (Cut Files Filter)：
            // 剪切文件（Ctrl+X）在粘贴后源文件即被物理移动，无法重复回放，故严格禁止进入历史队列
            if (core.type === 'files' && isFileCutOperation(gBytes)) {
                this._log('[RawClipboard] 拦截剪切文件操作：源文件移动后不可回放，不进入历史队列');
                return;
            }

            // 再次校验生命周期与抢占状态，若在读取或处理过程中已被取消或抢占，则放弃入库
            if (!this._cancellable || this._cancellable.is_cancelled() ||
                readCancellable.is_cancelled() ||
                this._currentReadCancellable !== readCancellable) {
                this._log('[RawClipboard] 读取已过时或被新所有者抢占，放弃入库');
                return;
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
                const previewInfo = generatePreview(core.type, core.mime, gBytes, unknownLabel, this._getLanguage(), {
                    textBytes: compositeTextBytes,
                    htmlBytes: compositeHtmlBytes,
                });
                let cachedThumb = undefined;
                let cachedChecksum = null;
                const thisRef = this;
                let entryTime = copyTime;

                const entryFormats = [];
                const isEn = thisRef._getLanguage() === 'en-US';
                let entryRef = null;

                if (core.type === 'composite') {
                    entryFormats.push({
                        mime: core.htmlMime || 'text/html',
                        type: 'html',
                        icon: 'text-html-symbolic',
                        label: isEn ? 'HTML' : '富文本',
                        get bytes() { return entryRef.htmlBytes; },
                    });
                    entryFormats.push({
                        mime: core.textMime || 'text/plain',
                        type: 'text',
                        icon: 'edit-copy-symbolic',
                        label: isEn ? 'Text' : '纯文本',
                        get bytes() { return entryRef.textBytes; },
                    });
                } else if (core.type === 'text') {
                    entryFormats.push({
                        mime: core.mime,
                        type: 'text',
                        icon: 'edit-copy-symbolic',
                        label: isEn ? 'Text' : '纯文本',
                        get bytes() { return entryRef.bytes; },
                    });
                } else if (core.type === 'html') {
                    entryFormats.push({
                        mime: 'text/html',
                        type: 'html',
                        icon: 'text-html-symbolic',
                        label: isEn ? 'HTML' : '富文本',
                        get bytes() { return entryRef.bytes; },
                    });
                } else if (core.type === 'files') {
                    entryFormats.push({
                        mime: core.mime,
                        type: 'files',
                        icon: previewInfo.icon || 'text-x-generic-symbolic',
                        label: isEn ? 'Files' : '文件',
                        get bytes() { return entryRef.bytes; },
                    });
                } else if (core.type === 'image') {
                    entryFormats.push({
                        mime: core.mime,
                        type: 'image',
                        icon: 'image-x-generic-symbolic',
                        label: isEn ? 'Image' : '图片',
                        get bytes() { return entryRef.bytes; },
                    });
                } else {
                    entryFormats.push({
                        mime: core.mime,
                        type: 'raw',
                        icon: 'application-x-generic-symbolic',
                        label: unknownLabel || (isEn ? 'Unknown' : '未知类型'),
                        get bytes() { return entryRef.bytes; },
                    });
                }

                // 注意：entry.bytes/checksum/thumbIcon 采用按需提取与轻量指纹，杜绝长期持有冗余物化缓冲；
                // 前缀树在后续分裂重构时，各次访问内容恒定等价，未持久缓存 assembledBytes，允许 GC 即时回收临时组装流。
                // 条目本身作为纯净只读视图冻结，不向外部泄露内部可变的 _radixNode。
                entryRef = Object.freeze({
                    id: `${copyTime}_${Math.floor(Math.random() * 1000)}`,
                    type: core.type,
                    mime: core.mime,
                    size: size,
                    formats: Object.freeze(entryFormats),
                    get bytes() {
                        const segs = leafNode.collectPathSegments();
                        if (segs.length === 1) {
                            return segs[0];
                        }
                        const out = Gio.MemoryOutputStream.new_resizable();
                        for (const s of segs) {
                            out.write_bytes(s, null);
                        }
                        out.close(null);
                        return out.steal_as_bytes();
                    },
                    get checksum() {
                        if (!cachedChecksum) {
                            cachedChecksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, this.bytes);
                        }
                        return cachedChecksum;
                    },
                    get parts() {
                        if (core.type === 'composite') {
                            return unpackCompositeBytes(this.bytes);
                        }
                        return [{ mime: core.mime, bytes: this.bytes }];
                    },
                    get htmlBytes() {
                        if (core.type === 'composite') {
                            return extractCompositePart(this.bytes, m => m.startsWith('text/html') || m.includes('html'));
                        }
                        return null;
                    },
                    get textBytes() {
                        if (core.type === 'composite') {
                            return extractCompositePart(this.bytes, m => m.startsWith('text/plain') || m.includes('STRING'));
                        }
                        return null;
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
                return entryRef;
            });

            // 释放临时复合流引用
            compositeTextBytes = null;
            compositeHtmlBytes = null;
            compositeParts = null;

            if (insertResult.isDuplicate) {
                // 再次严格校验生命周期与抢占状态，严禁在取消或抢占后更新历史、恢复软删除条目或调整时间戳
                if (!this._cancellable || this._cancellable.is_cancelled() ||
                    readCancellable.is_cancelled() ||
                    this._currentReadCancellable !== readCancellable) {
                    this._log('[RawClipboard] 重复条目检查时读取已过时或被抢占，放弃更新历史');
                    return;
                }

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
            if (overallSettingsChangedId > 0 && boundSettings) {
                try {
                    boundSettings.disconnect(overallSettingsChangedId);
                } catch (_) {}
                overallSettingsChangedId = 0;
            }
            if (watchdogId > 0) {
                this._removeTimeout(watchdogId);
                watchdogId = 0;
            }
            if (overallTimeoutId > 0) {
                this._removeTimeout(overallTimeoutId);
                overallTimeoutId = 0;
            }
            if (parentCancelId > 0 && boundCancellable) {
                try {
                    boundCancellable.disconnect(parentCancelId);
                } catch (_) {}
                parentCancelId = 0;
            }
            if (this._currentReadCancellable === readCancellable) {
                this._currentReadCancellable = null;
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

        // 3. 全局总内存上限裁剪 (FIFO: 若存储树实际物理大小或历史条目逻辑大小超出此限制，则自动移除最早的一项或多项记录，直到低于限制)
        let totalEntryBytes = this.#history.reduce((sum, item) => sum + (typeof item.size === 'number' ? item.size : (item.bytes ? item.bytes.get_size() : 0)), 0);
        let totalTreeBytes = this.#radixTree.getTotalBytes ? this.#radixTree.getTotalBytes() : totalEntryBytes;
        let totalBytes = Math.max(totalEntryBytes, totalTreeBytes);

        while (this.#history.length > 0 && totalBytes > maxTotalBytes) {
            const popped = this.#history.pop();
            if (popped) {
                this._log(`[RawClipboard] 超过历史总内存上限 (${maxTotalMb} MB)，淘汰最旧条目: ${this._formatEntryLog(popped)}`);
                this.#radixTree.remove(popped);
                if (this.#deletedEntries.has(popped)) {
                    this.#deletedEntries.delete(popped);
                    this._undoStack = this._undoStack.filter(e => e !== popped);
                }
                totalEntryBytes -= (typeof popped.size === 'number' ? popped.size : (popped.bytes ? popped.bytes.get_size() : 0));
                totalTreeBytes = this.#radixTree.getTotalBytes ? this.#radixTree.getTotalBytes() : totalEntryBytes;
                totalBytes = Math.max(totalEntryBytes, totalTreeBytes);
            }
        }

        this._updateUndoButton();

        // 若弹窗正处于打开状态，合并刷新列表
        if (this._popup && this._popup.visible) {
            this._queueRender();
        }
    }

    _restoreEntryFormat(entry, targetMime = null) {
        const entrySize = typeof entry?.size === 'number' ? entry.size : (entry?.bytes?.get_size ? entry.bytes.get_size() : 0);
        if (entrySize <= 0) return;
        const selectedMime = targetMime || ((entry.type === 'composite') ? 'text/html' : (entry.formats && entry.formats.length > 0 ? entry.formats[0].mime : entry.mime));
        this._log(`[RawClipboard] 正在按指定格式恢复条目至系统剪贴板: ${this._formatEntryLog(entry)} (MIME: ${selectedMime})`);

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
            this._addTimeout(500, () => {
                this.#activeNonces.delete(nonce);
                return GLib.SOURCE_REMOVE;
            });

            this._isRestoring = true;
            try {
                let source = null;
                let mime = selectedMime;
                let contentBytes = null;

                if (entry.type === 'composite') {
                    if (mime === 'text/html' || mime.includes('html')) {
                        mime = 'text/html';
                        contentBytes = entry.htmlBytes || entry.bytes;
                    } else if (mime.startsWith('text/plain') || mime.includes('STRING')) {
                        contentBytes = entry.textBytes || entry.bytes;
                    } else {
                        contentBytes = extractCompositePart(entry.bytes, mime) || entry.bytes;
                    }
                } else {
                    contentBytes = entry.bytes;
                }

                if (Meta && Meta.SelectionSourceMemory && typeof Meta.SelectionSourceMemory.new === 'function') {
                    try {
                        source = Meta.SelectionSourceMemory.new(mime, contentBytes);
                    } catch (_e) {}
                }

                if (source) {
                    source[RESTORE_NONCE] = nonce;
                    if (this._selection && typeof this._selection.set_owner === 'function') {
                        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
                    } else {
                        const clipboard = St.Clipboard.get_default();
                        clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, contentBytes);
                    }
                } else {
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, contentBytes);
                }
                this._debug(`[RawClipboard] 成功以格式 (${mime}) 写回系统剪贴板并挂载防回环标识`);
            } finally {
                this._isRestoring = false;
            }
        } catch (e) {
            this._error('[RawClipboard] Restore failed:', e);
        }
    }

    _restoreEntry(entry) {
        if (!entry) return;
        const defaultMime = (entry.type === 'composite') ? 'text/html' : (entry.formats && entry.formats.length > 0 ? entry.formats[0].mime : entry.mime);
        this._restoreEntryFormat(entry, defaultMime);
    }

    // 获取条目支持的右键操作列表 (Context Menu Action Options)
    _getAvailableConversions(entry) {
        if (!entry) return [];
        const isEn = this._getLanguage() === 'en-US';
        const conversions = [];

        // 复制文本 (Copy Text):
        // 转换为文本对所有以文本形式预览的记录开放 (非纯文本但能以文本预览的记录: 富文本 HTML、文件列表、多类型、未知类型等)
        if (entry.type !== 'text' && this._isTextPreviewable(entry)) {
            conversions.push({
                targetType: 'text',
                label: isEn ? 'Copy Text' : '复制文本',
                icon: 'edit-copy-symbolic',
            });
        }

        return conversions;
    }

    // 复制文本 / 类型转换引擎 (Copy as Text Engine):
    // 直接换文本类型标签，不再进行任何解析和修改；原样以文本类型回灌剪贴板，并向队首注入相同的文本记录
    _convertEntry(entry, targetType) {
        if (!entry || !targetType) return;
        if (targetType === 'text') {
            // 直接换文本类型标签，不再进行任何解析和修改
            const textBytes = (entry.type === 'composite') ? (entry.textBytes || entry.bytes) : entry.bytes;
            if (!textBytes || textBytes.get_size() === 0) return;

            const mime = 'text/plain;charset=utf-8';
            const copyTime = Date.now();

            // 1. 生成单次回环标识并挂载至数据源对象，回灌守卫照常工作
            const nonce = GLib.uuid_string_random();
            this.#activeNonces.add(nonce);
            this._addTimeout(500, () => {
                this.#activeNonces.delete(nonce);
                return GLib.SOURCE_REMOVE;
            });

            this._isRestoring = true;
            try {
                let source = null;
                if (Meta && Meta.SelectionSourceMemory && typeof Meta.SelectionSourceMemory.new === 'function') {
                    try {
                        source = Meta.SelectionSourceMemory.new(mime, textBytes);
                    } catch (_e) {}
                }
                if (source) {
                    source[RESTORE_NONCE] = nonce;
                    if (this._selection && typeof this._selection.set_owner === 'function') {
                        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
                    } else {
                        const clipboard = St.Clipboard.get_default();
                        clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, textBytes);
                    }
                } else {
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, textBytes);
                }
                this._debug(`[RawClipboard] 类型转换：成功将纯文本形式注入系统剪贴板并挂载防回环标识`);
            } finally {
                this._isRestoring = false;
            }

            // 2. 通过代码确保注入剪贴板的内容和添加到队首的内容一致
            const size = textBytes.get_size();
            const thisRef = this;
            const insertResult = this.#radixTree.insert(mime, textBytes, leafNode => {
                const previewInfo = generatePreview('text', mime, textBytes, null, thisRef._getLanguage());
                let cachedChecksum = null;
                let entryTime = copyTime;
                let entryRef = null;

                entryRef = Object.freeze({
                    id: `${copyTime}_${Math.floor(Math.random() * 1000)}`,
                    type: 'text',
                    mime: mime,
                    size: size,
                    formats: Object.freeze([{
                        mime: mime,
                        type: 'text',
                        icon: 'edit-copy-symbolic',
                        label: thisRef._getLanguage() === 'en-US' ? 'Text' : '纯文本',
                        get bytes() { return entryRef.bytes; },
                    }]),
                    get bytes() {
                        const segs = leafNode.collectPathSegments();
                        if (segs.length === 1) {
                            return segs[0];
                        }
                        const out = Gio.MemoryOutputStream.new_resizable();
                        for (const s of segs) {
                            out.write_bytes(s, null);
                        }
                        out.close(null);
                        return out.steal_as_bytes();
                    },
                    get checksum() {
                        if (!cachedChecksum) {
                            cachedChecksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, this.bytes);
                        }
                        return cachedChecksum;
                    },
                    get thumbIcon() {
                        return null;
                    },
                    preview: previewInfo.title,
                    subtitle: previewInfo.subtitle,
                    icon: previewInfo.icon,
                    get time() { return entryTime; },
                    set time(val) { if (typeof val === 'number') entryTime = val; },
                });
                return entryRef;
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

                const existingIdx = this.#history.indexOf(existing);
                if (existingIdx !== 0) {
                    if (existingIdx > 0) {
                        this.#history.splice(existingIdx, 1);
                    }
                    this.#history.unshift(existing);
                }
            } else {
                this.#history.unshift(insertResult.newEntry);
                this._enforceLimit();
            }

            if (this._popup) {
                this._closeContextMenu();
                this._closePopup();
            }
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
        this._loopArmDirection = null;
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
        this._loopArmDirection = null;
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

    _loopArmDirection = null; // null | 'up' | 'down'

    _clearLoopArm() {
        if (this._loopArmDirection) {
            this._loopArmDirection = null;
            this._updatePageBadge();
        }
    }

    _updatePageBadge() {
        if (!this._pageBadge) return;
        const currentEntries = this._getSortedEntries();
        const totalCount = currentEntries.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / 8));
        if (totalCount === 0 || totalPages <= 1) {
            this._pageBadge.hide();
            this._pageBadge.text = '';
            this._loopArmDirection = null;
        } else if (this._loopArmDirection) {
            const isEn = this._getLanguage() === 'en-US';
            const loopPrompt = isEn ? 'Loop? ' : '循环？ ';
            this._pageBadge.text = `${loopPrompt}${this._currentPage + 1} / ${totalPages}`;
            this._pageBadge.show();
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
        this._loopArmDirection = null;

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

            // 阻断弹窗内部的点击事件冒泡，若有右键菜单优先关闭右键菜单，若处于搜索状态，点击弹窗空白区域优先退出搜索状态
            this._popup.connect('button-press-event', () => {
                if (this._contextMenu) {
                    this._closeContextMenu();
                    return Clutter.EVENT_STOP;
                }
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

            const isEn = this._getLanguage() === 'en-US';
            this._sortButtons = new Map();
            const sortOptions = [
                { id: 'queue', label: isEn ? 'Order' : '记录顺序' },
                { id: 'size', label: isEn ? 'Size' : '大小' },
                { id: 'type', label: isEn ? 'Type' : '类型' },
                { id: 'initial', label: isEn ? 'A-Z' : '首字母' },
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
                btn._labelActor = btnLabel;
                btn.connect('button-press-event', (_actor, event) => {
                    if (this._contextMenu) {
                        this._closeContextMenu();
                    }
                    if (event.get_button() === 1) {
                        this._setSortMode(opt.id);
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                btn.connect('button-release-event', () => Clutter.EVENT_STOP);
                btn.connect('clicked', () => {
                    if (this._contextMenu) {
                        this._closeContextMenu();
                    }
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
                if (this._contextMenu) {
                    this._closeContextMenu();
                    return Clutter.EVENT_STOP;
                }
                if (this._inSearchMode) {
                    this._exitSearchMode();
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

            // 搜索显示标签：纯键盘直接响应无光标，彻底禁用输入法，根除输入法弹窗遮挡与首字母遗漏
            this._searchEntry = new St.Label({
                style_class: 'raw-clipboard-search-entry hint',
                text: this._getSearchPlaceholder(),
                reactive: false,
                can_focus: false,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (this._searchEntry.clutter_text) {
                this._searchEntry.clutter_text.use_markup = false;
                this._searchEntry.clutter_text.ellipsize = Pango.EllipsizeMode.END;
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
                if (this._contextMenu) {
                    this._closeContextMenu();
                    return Clutter.EVENT_STOP;
                }
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
                if (this._contextMenu) {
                    this._closeContextMenu();
                    return Clutter.EVENT_STOP;
                }
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
                text: isEn ? 'Undo' : '撤销',
                style_class: 'raw-clipboard-undo-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (undoLabel.clutter_text) {
                undoLabel.clutter_text.use_markup = false;
            }
            this._undoLabel = undoLabel;

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
                if (this._contextMenu) {
                    this._closeContextMenu();
                }
                this._undoLastDelete();
            });
            this._undoBtn.connect('button-press-event', (_actor, event) => {
                if (this._contextMenu) {
                    this._closeContextMenu();
                }
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

            // 鼠标滚轮与触控板翻页监听 (优化触控板手势算法：手势锁步、单次划动翻一页、阻尼过滤防失控)
            let lastScrollTime = 0;
            let lastScrollDir = 0;
            let smoothAccumulator = 0;
            let smoothGestureLocked = false;
            let lastSmoothTime = 0;

            const SMOOTH_THRESHOLD = 0.35; // 阻尼门槛：过滤手指轻微触碰抖动 (同时保持 dy=0.5 单步测试兼容)
            const SMOOTH_TIMEOUT_MS = 180; // 180ms 静止或手指抬起即判定划动手势结束，解除锁步
            const WHEEL_DEBOUNCE_MS = 60; // 机械滚轮防抖：过滤瞬间机械抖动，保障连续滚轮与方向键一致的顺滑响应

            const handleScrollEvent = (_actor, event) => {
                if (this._contextMenu) {
                    this._closeContextMenu();
                }
                const currentEntries = this._getSortedEntries();
                const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
                if (totalPages <= 1) return Clutter.EVENT_STOP;

                const now = Date.now();
                const direction = event.get_scroll_direction();
                let delta = 0;

                // 优先检测驱动层触控板抬手/手势终止标志 (Clutter.ScrollFinishFlags.VERTICAL)
                const finishFlags = (typeof event.get_scroll_finish_flags === 'function')
                    ? event.get_scroll_finish_flags()
                    : 0;
                const isFinish = finishFlags && (finishFlags & Clutter.ScrollFinishFlags.VERTICAL);
                if (isFinish) {
                    smoothGestureLocked = false;
                    smoothAccumulator = 0;
                    lastSmoothTime = 0;
                }

                if (direction === Clutter.ScrollDirection.UP) {
                    delta = -1;
                    smoothGestureLocked = false;
                    smoothAccumulator = 0;
                } else if (direction === Clutter.ScrollDirection.DOWN) {
                    delta = 1;
                    smoothGestureLocked = false;
                    smoothAccumulator = 0;
                } else if (direction === Clutter.ScrollDirection.SMOOTH) {
                    const [, dy] = event.get_scroll_delta();

                    // 超时重置：若距离上次平滑事件超过 180ms，说明上一次划动已静止，释放手势锁
                    if (now - lastSmoothTime > SMOOTH_TIMEOUT_MS) {
                        smoothGestureLocked = false;
                        smoothAccumulator = 0;
                    }
                    lastSmoothTime = now;

                    // 反向划动检测：若在锁定期间用户明确向反方向划动，立即解除锁定并响应反向操作
                    const currentSign = dy > 0.05 ? 1 : (dy < -0.05 ? -1 : 0);
                    if (currentSign !== 0 && lastScrollDir !== 0 && currentSign !== lastScrollDir) {
                        smoothGestureLocked = false;
                        smoothAccumulator = 0;
                    }

                    // 触控板单次划动锁步（One Swipe = Exactly One Page）：
                    // 一旦当前划动已触发过翻页，在手指抬起或停顿前，全量吸收后续同一手势的事件，彻底根除失控飞速翻页
                    if (smoothGestureLocked) {
                        return Clutter.EVENT_STOP;
                    }

                    smoothAccumulator += dy;
                    if (smoothAccumulator >= SMOOTH_THRESHOLD) {
                        delta = 1;
                        smoothAccumulator = 0;
                        smoothGestureLocked = true; // 锁定当前手势，一次划动只翻一页
                    } else if (smoothAccumulator <= -SMOOTH_THRESHOLD) {
                        delta = -1;
                        smoothAccumulator = 0;
                        smoothGestureLocked = true; // 锁定当前手势，一次划动只翻一页
                    } else {
                        return Clutter.EVENT_STOP;
                    }
                }

                if (delta !== 0) {
                    // 机械滚轮防抖（平滑手势已由单次锁步机制保护，不依赖短毫秒防抖）
                    if (direction !== Clutter.ScrollDirection.SMOOTH) {
                        const isReversal = (lastScrollDir !== 0 && delta !== lastScrollDir);
                        if (!isReversal && (now - lastScrollTime < WHEEL_DEBOUNCE_MS)) {
                            return Clutter.EVENT_STOP;
                        }
                    }

                    // 首尾循环翻页防误触：第一页向上翻至末页、或最后一页向下翻至第一页时，首次操作仅提示“循环？”，二次操作才执行翻页
                    if (delta < 0 && this._currentPage === 0) {
                        if (this._loopArmDirection !== 'up') {
                            this._loopArmDirection = 'up';
                            this._updatePageBadge();
                            lastScrollTime = now;
                            lastScrollDir = delta;
                            return Clutter.EVENT_STOP;
                        }
                    } else if (delta > 0 && this._currentPage === totalPages - 1) {
                        if (this._loopArmDirection !== 'down') {
                            this._loopArmDirection = 'down';
                            this._updatePageBadge();
                            lastScrollTime = now;
                            lastScrollDir = delta;
                            return Clutter.EVENT_STOP;
                        }
                    }

                    // 循环翻页执行（或常规单步翻页），并还原正常页码显示
                    this._loopArmDirection = null;
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
                if (this._contextMenu) {
                    this._closeContextMenu();
                    return Clutter.EVENT_STOP;
                }
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
            this._destroyPopupUI();
        }
    }

    _openContextMenu(entry, x, y) {
        this._closeContextMenu();
        if (!entry || !this._container) return;

        const isEn = this._getLanguage() === 'en-US';

        const menu = new St.BoxLayout({
            name: 'rawClipboardContextMenu',
            style_class: 'raw-clipboard-context-menu',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });

        menu.connect('button-press-event', () => Clutter.EVENT_STOP);
        menu.connect('button-release-event', () => Clutter.EVENT_STOP);

        // 1. 带入搜索 (Search Preview)
        const searchBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        const searchIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'raw-clipboard-menu-item-icon',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const searchLabel = new St.Label({
            text: isEn ? 'Search Preview' : '带入搜索',
            style_class: 'raw-clipboard-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (searchLabel.clutter_text) searchLabel.clutter_text.use_markup = false;
        searchBox.add_child(searchIcon);
        searchBox.add_child(searchLabel);

        const searchBtn = new St.Button({
            style_class: 'raw-clipboard-menu-item',
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: searchBox,
            x_expand: true,
        });
        let searchHandled = false;
        const doSearch = () => {
            if (searchHandled) return;
            searchHandled = true;
            let preview = entry.preview || '';
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
                const segments = Array.from(segmenter.segment(preview));
                if (segments.length > MAX_SEARCH_IMPORT_LEN) {
                    preview = segments.slice(0, MAX_SEARCH_IMPORT_LEN).map(s => s.segment).join('');
                }
            } else {
                preview = Array.from(preview).slice(0, MAX_SEARCH_IMPORT_LEN).join('');
            }
            this._closeContextMenu();
            this._enterSearchMode(preview);
        };
        searchBtn.connect('clicked', doSearch);
        searchBtn.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 1) {
                doSearch();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        });
        menu.add_child(searchBtn);

        // 2. 类型转换 (Type Conversion) - 抽象数据格式转换功能
        const conversions = this._getAvailableConversions(entry);
        for (const conv of conversions) {
            const convBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            const convIcon = new St.Icon({
                icon_name: conv.icon || 'format-text-plaintext-symbolic',
                style_class: 'raw-clipboard-menu-item-icon',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const convLabel = new St.Label({
                text: conv.label,
                style_class: 'raw-clipboard-menu-item-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (convLabel.clutter_text) convLabel.clutter_text.use_markup = false;
            convBox.add_child(convIcon);
            convBox.add_child(convLabel);

            const convBtn = new St.Button({
                style_class: 'raw-clipboard-menu-item',
                can_focus: true,
                reactive: true,
                track_hover: true,
                child: convBox,
                x_expand: true,
            });
            let convHandled = false;
            const doConvert = () => {
                if (convHandled) return;
                convHandled = true;
                this._convertEntry(entry, conv.targetType);
            };
            convBtn.connect('clicked', doConvert);
            convBtn.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 1) {
                    doConvert();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_STOP;
            });
            menu.add_child(convBtn);
        }

        this._contextMenu = menu;
        this._container.add_child(menu);

        // 定位与屏幕边缘保护：按点击坐标或主容器所在屏幕匹配对应显示器
        let posX = (typeof x === 'number' && !isNaN(x)) ? x : 0;
        let posY = (typeof y === 'number' && !isNaN(y)) ? y : 0;

        let monitor = null;
        const monitors = Main.layoutManager.monitors || [];
        for (const m of monitors) {
            if (posX >= m.x && posX < m.x + m.width && posY >= m.y && posY < m.y + m.height) {
                monitor = m;
                break;
            }
        }
        if (!monitor && this._container) {
            const [cX, cY] = this._container.get_position ? this._container.get_position() : [this._container.x || 0, this._container.y || 0];
            for (const m of monitors) {
                if (cX >= m.x && cX < m.x + m.width && cY >= m.y && cY < m.y + m.height) {
                    monitor = m;
                    break;
                }
            }
        }
        if (!monitor) {
            monitor = Main.layoutManager.primaryMonitor || { x: 0, y: 0, width: global.stage.width, height: global.stage.height };
        }

        const menuWidth = 140;
        const menuHeight = (conversions.length > 0) ? (38 + conversions.length * 34) : 38;

        if (posX + menuWidth > monitor.x + monitor.width - 8) {
            posX = posX - menuWidth;
        }
        if (posY + menuHeight > monitor.y + monitor.height - 8) {
            posY = posY - menuHeight;
        }
        posX = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - menuWidth - 8, posX));
        posY = Math.max(monitor.y + 8, Math.min(monitor.y + monitor.height - menuHeight - 8, posY));

        menu.set_position(posX, posY);
    }

    _closeContextMenu() {
        if (!this._contextMenu) return;
        try {
            const parent = this._contextMenu.get_parent ? this._contextMenu.get_parent() : this._contextMenu.parent;
            if (parent && typeof parent.remove_child === 'function') {
                parent.remove_child(this._contextMenu);
            }
            if (typeof this._contextMenu.destroy === 'function') {
                this._contextMenu.destroy();
            }
        } catch (_) {}
        this._contextMenu = null;
    }

    _destroyPopupUI() {
        this._closeContextMenu();
        if (this._grab) {
            try { Main.popModal(this._grab); } catch (_) {}
            this._grab = null;
        }
        if (this._renderIdleId) {
            try { GLib.source_remove(this._renderIdleId); } catch (_) {}
            this._renderIdleId = 0;
        }

        // 彻底切断所有 JS 槽位对条目的引用与闭包持有
        if (this._itemSlots) {
            for (const slot of this._itemSlots) {
                if (slot) {
                    slot.currentEntry = null;
                    slot.currentGIcon = null;
                    slot.currentIconName = null;
                    if (slot.typeBtn0) slot.typeBtn0._targetMime = null;
                    if (slot.typeBtn1) slot.typeBtn1._targetMime = null;
                    try { slot.itemBox.destroy(); } catch (_) {}
                    slot.itemBox = null;
                    slot.iconBox = null;
                    slot.iconActor = null;
                    slot.typeBtn0 = null;
                    slot.typeBtn1 = null;
                    slot.contentBox = null;
                    slot.previewLabel = null;
                    slot.subLabel = null;
                    slot.timeLabel = null;
                    slot.deleteBtn = null;
                }
            }
            this._itemSlots = null;
        }
        this._itemActors = null;

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
        }

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
        this._undoLabel = null;
        this._loopBadge = null;
        this._sortMode = 'queue';
        this._inSearchMode = false;
        this._searchQuery = '';
        this._loopArmDirection = null;
        this._isClosing = false;
    }

    _closePopup() {
        if (!this._container) return;
        if (this._isClosing) {
            this._destroyPopupUI();
            return;
        }
        this._closeContextMenu();
        this._isClosing = true;
        this._debug('[RawClipboard] 关闭剪贴板窗口');

        // 退出弹窗后，统一执行物理删除
        this._commitPendingDeletions();

        // 立即释放模态抓取，确保键盘和系统焦点即时回归
        if (this._grab) {
            try { Main.popModal(this._grab); } catch (_) {}
            this._grab = null;
        }

        // 禁用遮罩交互，防止动画期间误触
        this._container.reactive = false;

        const animDuration = shouldUseMotion() ? 100 : 0;

        const cleanup = () => {
            this._destroyPopupUI();
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
        this._loopArmDirection = null;
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

        // 左侧类型回灌选择按钮容器 (扁平化正方形区域，支持多类型选择回灌)
        const iconBox = new St.BoxLayout({
            style_class: 'raw-clipboard-type-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            reactive: true,
        });

        const handleTypeClick = (btn) => {
            if (this._contextMenu) {
                this._closeContextMenu();
            }
            if (slot.currentEntry && btn._targetMime) {
                this._restoreEntryFormat(slot.currentEntry, btn._targetMime);
                this._closePopup();
            }
        };

        const createTypeBtn = (isFirst) => {
            const icon = new St.Icon({
                icon_name: 'edit-copy-symbolic',
                style_class: 'raw-clipboard-item-icon',
                icon_size: 20,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });
            const btn = new St.Button({
                style_class: isFirst ? 'raw-clipboard-type-btn first-btn' : 'raw-clipboard-type-btn',
                can_focus: true,
                reactive: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
                child: icon,
            });
            btn.set_size(48, 48);
            btn.width = 48;
            btn.height = 48;
            btn._icon = icon;
            btn._targetMime = null;

            btn.connect('button-press-event', (_actor, event) => {
                const b = event.get_button();
                if (b === 1) {
                    handleTypeClick(btn);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            btn.connect('button-release-event', () => Clutter.EVENT_STOP);
            btn.connect('clicked', () => handleTypeClick(btn));

            return btn;
        };

        const typeBtn0 = createTypeBtn(true);
        const typeBtn1 = createTypeBtn(false);
        typeBtn1.hide();

        iconBox.add_child(typeBtn0);
        iconBox.add_child(typeBtn1);
        itemBox.add_child(iconBox);

        // 兼容测试中的 itemBox.get_children()[0].icon_name 与 gicon 访问
        Object.defineProperty(iconBox, 'icon_name', {
            get: () => typeBtn0._icon.icon_name,
            set: (v) => { typeBtn0._icon.icon_name = v; },
            configurable: true,
        });
        Object.defineProperty(iconBox, 'gicon', {
            get: () => typeBtn0._icon.gicon,
            set: (v) => { typeBtn0._icon.gicon = v; },
            configurable: true,
        });

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
            iconBox,
            iconActor: typeBtn0._icon,
            typeBtn0,
            typeBtn1,
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
            if (this._contextMenu) {
                this._closeContextMenu();
            }
            if (event.get_button() === 1 && slot.currentEntry) {
                this._deleteEntry(slot.currentEntry);
            }
            return Clutter.EVENT_STOP;
        });
        deleteBtn.connect('button-release-event', () => Clutter.EVENT_STOP);
        deleteBtn.connect('clicked', () => {
            if (this._contextMenu) {
                this._closeContextMenu();
            }
            if (slot.currentEntry) {
                this._deleteEntry(slot.currentEntry);
            }
        });
        itemBox.add_child(deleteBtn);

        // 点击条目交互：左键恢复，右键弹出上下文操作菜单
        itemBox.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === 1 && slot.currentEntry) {
                if (this._contextMenu) {
                    this._closeContextMenu();
                    return Clutter.EVENT_STOP;
                }
                try {
                    this._restoreEntry(slot.currentEntry);
                    this._closePopup();
                } catch (e) {
                    this._error('[RawClipboard] Restore on click failed:', e);
                }
                return Clutter.EVENT_STOP;
            } else if (button === 3 && slot.currentEntry) {
                this._setSelectedIndex(slotIndex);
                let coords = null;
                if (typeof event.get_coords === 'function') {
                    coords = event.get_coords();
                }
                if (!coords || !Array.isArray(coords)) {
                    coords = global.get_pointer ? global.get_pointer() : [0, 0];
                }
                const [x, y] = coords;
                this._openContextMenu(slot.currentEntry, x, y);
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

    _applySlotIcon(slot) {
        const entry = slot.currentEntry;
        if (!entry) return;

        const formats = (entry.formats && entry.formats.length > 0) ? entry.formats : [{
            mime: entry.mime,
            type: entry.type,
            icon: entry.icon || 'edit-copy-symbolic',
        }];

        // 格式 0 (主格式)
        const fmt0 = formats[0];
        slot.typeBtn0._targetMime = fmt0.mime;
        if (entry.thumbIcon) {
            if (slot.currentGIcon !== entry.thumbIcon) {
                slot.typeBtn0._icon.icon_name = null;
                slot.typeBtn0._icon.gicon = entry.thumbIcon;
                slot.typeBtn0._icon.style_class = 'raw-clipboard-item-thumb';
                slot.typeBtn0._icon.icon_size = 34;
                slot.currentGIcon = entry.thumbIcon;
                slot.currentIconName = null;
            }
        } else {
            const iconName = fmt0.icon || entry.icon || 'edit-copy-symbolic';
            if (slot.currentIconName !== iconName || slot.currentGIcon !== null) {
                slot.typeBtn0._icon.gicon = null;
                slot.typeBtn0._icon.icon_name = iconName;
                slot.typeBtn0._icon.style_class = 'raw-clipboard-item-icon';
                slot.typeBtn0._icon.icon_size = 20;
                slot.currentIconName = iconName;
                slot.currentGIcon = null;
            }
        }
        slot.typeBtn0.show();

        // 格式 1 (副格式，多类型时并排显示)
        if (formats.length > 1) {
            const fmt1 = formats[1];
            slot.typeBtn1._targetMime = fmt1.mime;
            slot.typeBtn1._icon.gicon = null;
            slot.typeBtn1._icon.icon_name = fmt1.icon || 'edit-copy-symbolic';
            slot.typeBtn1._icon.style_class = 'raw-clipboard-item-icon';
            slot.typeBtn1._icon.icon_size = 20;
            slot.typeBtn1.show();
        } else {
            slot.typeBtn1._targetMime = null;
            slot.typeBtn1.hide();
        }
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
                    text: this._getEmptyText(),
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
            this._emptyLabel.text = this._getEmptyText();
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

            // 1. 图标/缩略图：仅在真实变更时更新，悬停时自动显示搜索图标
            this._applySlotIcon(slot);

            // 2. 文字与时间在位更新
            const previewText = this._getEntryPreview(entry);
            if (slot.previewLabel.text !== previewText) {
                slot.previewLabel.text = previewText;
            }
            const subtitleText = this._getEntrySubtitle(entry);
            if (slot.subLabel.text !== subtitleText) {
                slot.subLabel.text = subtitleText;
            }
            const timeText = this._formatTime(entry.time);
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

    _getSelectedEntry() {
        if (this._itemSlots && this._selectedIndex >= 0 && this._selectedIndex < this._itemSlots.length) {
            const slot = this._itemSlots[this._selectedIndex];
            if (slot && slot.currentEntry) {
                return slot.currentEntry;
            }
        }
        return null;
    }

    _setSelectedIndex(index) {
        const pageCount = (this._itemActors && this._itemActors.length > 0)
            ? this._itemActors.length
            : Math.min(8, Math.max(0, this._getSortedEntries().length - this._currentPage * 8));
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
        const symbol = event.get_key_symbol();

        // Esc: 若有右键菜单，先关闭右键菜单；若在搜索模式，先退出搜索状态回到完整列表；否则关闭弹窗
        if (symbol === Clutter.KEY_Escape) {
            if (this._contextMenu) {
                this._closeContextMenu();
                return Clutter.EVENT_STOP;
            }
            if (this._inSearchMode) {
                this._exitSearchMode();
                return Clutter.EVENT_STOP;
            }
            this._closePopup();
            return Clutter.EVENT_STOP;
        }

        if (this._contextMenu) {
            this._closeContextMenu();
        }

        const state = typeof event.get_state === 'function' ? event.get_state() : 0;
        const SORT_MODES = ['queue', 'size', 'type', 'initial'];
        const isShift = Boolean(state & Clutter.ModifierType.SHIFT_MASK);

        // Tab / Shift+Tab: 循环切换排序方式 (记录顺序 -> 大小 -> 类型 -> 首字母) - 仅在非搜索模式下生效
        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab) {
            if (!this._inSearchMode) {
                const curIdx = SORT_MODES.indexOf(this._sortMode);
                const nextIdx = (isShift || symbol === Clutter.KEY_ISO_Left_Tab)
                    ? (curIdx - 1 + SORT_MODES.length) % SORT_MODES.length
                    : (curIdx + 1) % SORT_MODES.length;
                this._setSortMode(SORT_MODES[nextIdx]);
            }
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

        const isCtrl = Boolean(state & Clutter.ModifierType.CONTROL_MASK);

        // Ctrl+Z: 撤销最近一次删除 (仅在非搜索模式下生效)
        if (isCtrl && (symbol === Clutter.KEY_z || symbol === Clutter.KEY_Z)) {
            if (!this._inSearchMode) {
                if (this._undoLastDelete()) {
                    return Clutter.EVENT_STOP;
                }
            }
        }

        // BackSpace 处理：
        // 搜索状态下：删除搜索词末尾字符；删光时不退出搜索状态，依然保留搜索框但显示无匹配项目
        // 非搜索状态下：删除当前选中的历史记录条目 (按当前已显示、已选中的条目身份操作，杜绝待重绘竞态错配)
        if (symbol === Clutter.KEY_BackSpace) {
            if (this._inSearchMode) {
                if (this._searchQuery.length > 0) {
                    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
                        const segments = Array.from(segmenter.segment(this._searchQuery));
                        if (segments.length > 0) {
                            this._searchQuery = segments.slice(0, -1).map(s => s.segment).join('');
                        } else {
                            this._searchQuery = '';
                        }
                    } else {
                        const chars = Array.from(this._searchQuery);
                        chars.pop();
                        this._searchQuery = chars.join('');
                    }
                    this._updateSearchDisplay();
                    this._currentPage = 0;
                    this._selectedIndex = 0;
                    this._renderPage();
                    this._updatePageBadge();
                }
                return Clutter.EVENT_STOP;
            } else {
                const targetEntry = this._getSelectedEntry();
                if (targetEntry) {
                    this._deleteEntry(targetEntry);
                }
                return Clutter.EVENT_STOP;
            }
        }

        // Delete 按键：仅在非搜索模式下执行删除，防止在搜索输入期间误删条目 (按当前已显示、已选中的条目身份操作)
        if (symbol === Clutter.KEY_Delete) {
            if (!this._inSearchMode) {
                const targetEntry = this._getSelectedEntry();
                if (targetEntry) {
                    this._deleteEntry(targetEntry);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // Enter / KP_Enter / Space: 确认选中并恢复 (按当前已显示、已选中的条目身份操作，杜绝待重绘竞态错配)
        // 注意：搜索状态下 Space 作为输入字符搜索，不可用于确认恢复
        const isConfirmKey = symbol === Clutter.KEY_Return ||
            symbol === Clutter.KEY_KP_Enter ||
            (!this._inSearchMode && symbol === Clutter.KEY_space);

        if (isConfirmKey) {
            const targetEntry = this._getSelectedEntry();
            if (targetEntry) {
                this._restoreEntry(targetEntry);
            }
            this._closePopup();
            return Clutter.EVENT_STOP;
        }

        // 方向键与翻页键导航
        const currentEntries = this._getSortedEntries();
        const totalCount = currentEntries.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / 8));
        const startIndex = this._currentPage * 8;
        const pageCount = (this._itemActors && this._itemActors.length > 0)
            ? this._itemActors.length
            : Math.max(0, Math.min(8, totalCount - startIndex));

        // Up: 上一项 (若在当前页首项，跨页滚动至上一页尾项)
        if (symbol === Clutter.KEY_Up) {
            if (totalCount > 0) {
                if (this._selectedIndex > 0) {
                    this._clearLoopArm();
                    this._setSelectedIndex(this._selectedIndex - 1);
                } else if (this._currentPage > 0) {
                    this._clearLoopArm();
                    const prevPageCount = 8;
                    this._setPage(this._currentPage - 1, prevPageCount - 1);
                } else if (totalPages > 1) {
                    // 第一页首项向上跨页至最后一页尾项：首次仅提示“循环？”，二次操作才执行翻页
                    if (this._loopArmDirection !== 'up') {
                        this._loopArmDirection = 'up';
                        this._updatePageBadge();
                        return Clutter.EVENT_STOP;
                    }
                    this._loopArmDirection = null;
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
                    this._clearLoopArm();
                    this._setSelectedIndex(this._selectedIndex + 1);
                } else if (this._currentPage < totalPages - 1) {
                    this._clearLoopArm();
                    this._setPage(this._currentPage + 1, 0);
                } else if (totalPages > 1) {
                    // 最后一页尾项向下跨页至第一页首项：首次仅提示“循环？”，二次操作才执行翻页
                    if (this._loopArmDirection !== 'down') {
                        this._loopArmDirection = 'down';
                        this._updatePageBadge();
                        return Clutter.EVENT_STOP;
                    }
                    this._loopArmDirection = null;
                    this._setPage(0, 0);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // Left / PageUp: 翻至上一页 (循环翻页：第一页向上翻至末页)
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Page_Up) {
            if (totalPages > 1) {
                if (this._currentPage === 0) {
                    if (this._loopArmDirection !== 'up') {
                        this._loopArmDirection = 'up';
                        this._updatePageBadge();
                        return Clutter.EVENT_STOP;
                    }
                }
                this._loopArmDirection = null;
                const targetPage = (this._currentPage - 1 + totalPages) % totalPages;
                this._setPage(targetPage, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // Right / PageDown: 翻至下一页 (循环翻页：末页向下翻至首页)
        if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Page_Down) {
            if (totalPages > 1) {
                if (this._currentPage === totalPages - 1) {
                    if (this._loopArmDirection !== 'down') {
                        this._loopArmDirection = 'down';
                        this._updatePageBadge();
                        return Clutter.EVENT_STOP;
                    }
                }
                this._loopArmDirection = null;
                const targetPage = (this._currentPage + 1) % totalPages;
                this._setPage(targetPage, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // 字符输入：键入任何文字时自动出现替代排序选项卡；已在搜索状态时追加输入
        const char = getPrintableChar(event);
        if (char) {
            if (!this._inSearchMode) {
                this._enterSearchMode(char);
                return Clutter.EVENT_STOP;
            } else {
                if (this._searchQuery.length < MAX_SEARCH_QUERY_LEN) {
                    this._searchQuery += char;
                    this._updateSearchDisplay();
                    this._currentPage = 0;
                    this._selectedIndex = 0;
                    this._renderPage();
                    this._updatePageBadge();
                }
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }
}
