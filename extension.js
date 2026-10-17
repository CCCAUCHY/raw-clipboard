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

// ============================================================================
// 1. 基础平台常量与工具函数 (Constants & Platform Utils)
// ============================================================================

export const RESTORE_NONCE = Symbol('raw-clipboard-restore-nonce');
export const INACTIVITY_TIMEOUT_MS = 5000;
export const OVERALL_TIMEOUT_MS = 15000;
export const MAX_SEARCH_QUERY_LEN = 128;
export const MAX_SEARCH_IMPORT_LEN = 64;

export const ICON_TEXT = 'text-t-symbolic';
export const ICON_HTML = 'code-symbolic';
export const ICON_FILES = 'folder-symbolic';
export const ICON_IMAGE = 'image-x-generic-symbolic';
export const ICON_RAW = 'edit-copy-symbolic';

export const Utf8Decoder = new TextDecoder();

export function callAsync(target, asyncMethod, finishMethod, ...args) {
    return new Promise((resolve, reject) => {
        try {
            const ret = target[asyncMethod](...args, (source, res) => {
                try {
                    const finishFn = source ? source[finishMethod] : target[finishMethod];
                    resolve(typeof finishFn === 'function' ? finishFn.call(source || target, res) : res);
                } catch (err) { reject(err); }
            });
            if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
        } catch (e) {
            try {
                const ret = target[asyncMethod](...args);
                if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
                else reject(e);
            } catch { reject(e); }
        }
    });
}

export function shouldUseMotion() {
    try {
        const settings = St.Settings.get();
        if (settings && St.ReducedMotion) {
            const val = settings.reduced_motion ?? settings.reducedMotion;
            return val !== St.ReducedMotion.REDUCE;
        }
    } catch {}
    return true;
}

export function formatByteSize(size) {
    if (typeof size !== 'number' || size < 0) return '0 B';
    return size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` :
           size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
}

export function formatTime(timestamp, lang = 'zh-CN') {
    if (!timestamp || typeof timestamp !== 'number') return '';
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const itemStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.max(0, Math.floor((todayStart - itemStart) / 86400000));
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (diffDays === 0) return `${timeStr}:${pad(d.getSeconds())}`;
    return lang === 'en-US' ? `${diffDays}d ago ${timeStr}` : `${diffDays}天前 ${timeStr}`;
}

export function getPrintableChar(event) {
    if (!event) return null;
    const symbol = typeof event.get_key_symbol === 'function' ? event.get_key_symbol() : 0;
    const state = typeof event.get_state === 'function' ? event.get_state() : 0;
    if (state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK)) {
        return null;
    }
    if (typeof event.get_key_unicode === 'function') {
        const u = event.get_key_unicode();
        if (u >= 32 && u !== 127) return String.fromCodePoint(u);
    }
    if (typeof Clutter.keysym_to_unicode === 'function') {
        const u = Clutter.keysym_to_unicode(symbol);
        if (u >= 32 && u !== 127) return String.fromCodePoint(u);
    }
    if (symbol >= 0x20 && symbol <= 0x7e) return String.fromCharCode(symbol);
    if (symbol >= 0x01000100 && symbol <= 0x0110ffff) return String.fromCodePoint(symbol - 0x01000000);
    return null;
}

// ============================================================================
// 2. 纯内存 Radix Raw 前缀树存储内核 (Radix Raw Tree Kernel)
// ============================================================================

export function findLongestCommonPrefix(a, b, offA = 0, offB = 0) {
    const isBytesA = a && typeof a.get_size === 'function';
    const isBytesB = b && typeof b.get_size === 'function';
    const sA = isBytesA ? a.get_size() : a.length;
    const sB = isBytesB ? b.get_size() : b.length;
    const len = Math.min(Math.max(0, sA - offA), Math.max(0, sB - offB));
    if (len === 0) return 0;

    const uA = isBytesA ? a.get_data() : a;
    const uB = isBytesB ? b.get_data() : b;
    let i = 0;
    const byteOffA = (uA.byteOffset || 0) + offA;
    const byteOffB = (uB.byteOffset || 0) + offB;

    if (uA.buffer && uB.buffer && ((byteOffA | byteOffB) & 3) === 0 && len >= 4) {
        const wordLen = len >>> 2;
        const u32A = new Uint32Array(uA.buffer, byteOffA, wordLen);
        const u32B = new Uint32Array(uB.buffer, byteOffB, wordLen);
        let w = 0;
        while (w < wordLen && u32A[w] === u32B[w]) w++;
        i = w << 2;
    }
    while (i < len && uA[offA + i] === uB[offB + i]) i++;
    return i;
}

export function normalizeBaseMime(mime) {
    if (!mime || typeof mime !== 'string') return '';
    return mime.trim().toLowerCase().split(';')[0].trim();
}

export function getSemanticMimeKey(mime) {
    if (!mime || typeof mime !== 'string') return '';
    const trimmed = mime.trim();
    const base = normalizeBaseMime(trimmed);
    if (['utf8_string', 'string', 'text'].includes(base)) {
        return 'text/plain';
    }
    if (base === 'text/plain') {
        const parts = trimmed.split(';');
        if (parts.length === 1) return 'text/plain';
        const params = parts.slice(1).map(p => p.trim().toLowerCase()).filter(Boolean).sort();
        const nonUtf8Params = params.filter(p => p !== 'charset=utf-8' && p !== 'charset=utf8');
        if (nonUtf8Params.length === 0) return 'text/plain';
        return `text/plain;${nonUtf8Params.join(';')}`;
    }
    const parts = trimmed.split(';');
    if (parts.length === 1) return base;
    const params = parts.slice(1).map(p => p.trim().toLowerCase()).filter(Boolean).sort().join(';');
    return `${base};${params}`;
}

export function normalizeMime(mime) {
    if (!mime) return 'default';
    const base = normalizeBaseMime(mime);
    if (base === 'text/plain' || base === 'utf8_string' || base === 'string' || base === 'text') {
        return 'text/plain';
    }
    if (base === 'text/html') {
        return 'text/html';
    }
    if (base === 'text/uri-list' || base === 'x-special/gnome-copied-files') {
        return base;
    }
    return base || mime;
}

export function makeSliceBytes(sourceBytes, uData, offset, len) {
    if (offset === 0 && len === uData.length) return sourceBytes;
    return new GLib.Bytes(uData.slice(offset, offset + len));
}

export class RadixNode {
    #firstByte = undefined;

    constructor(bytes = null, parent = null, firstByte = undefined) {
        this.bytes = bytes;
        this.parent = parent;
        this.children = new Map();
        this.entries = new Map();
        this.entry = null;
        this.#firstByte = firstByte;
    }

    get firstByte() {
        if (this.#firstByte !== undefined) return this.#firstByte;
        if (!this.bytes || (typeof this.bytes.get_size === 'function' && this.bytes.get_size() === 0)) return null;
        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(this.bytes);
            const b1 = stream.read_bytes(1, null);
            this.#firstByte = (b1 && b1.get_size() > 0) ? b1.get_data()[0] : null;
        } catch {
            const d = this.bytes.get_data ? this.bytes.get_data() : null;
            this.#firstByte = d ? d[0] : null;
        }
        return this.#firstByte;
    }

    get data() {
        return this.bytes ? this.bytes.get_data() : null;
    }

    setBytes(bytes, firstByte = undefined) {
        this.bytes = bytes;
        this.#firstByte = firstByte;
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
        this._root = new RadixNode(null, null);
        this._roots = new Map();
    }

    get root() { return this._root; }
    get rootCount() { return this._roots.size; }
    hasRoot(mime) {
        const k1 = getSemanticMimeKey(mime);
        const k2 = normalizeMime(mime);
        return this._roots.has(k1) || this._roots.has(k2);
    }
    getRoot(mime) {
        const k1 = getSemanticMimeKey(mime);
        const k2 = normalizeMime(mime);
        return (this._roots.has(k1) || this._roots.has(k2)) ? this._root : null;
    }
    _getRoot(mime) {
        const k = getSemanticMimeKey(mime) || normalizeMime(mime);
        if (!this._roots.has(k)) {
            this._roots.set(k, this._root);
        }
        return this._root;
    }

    getNode(entry) {
        return entry ? (this.#nodeByEntry.get(entry) || entry._radixNode || null) : null;
    }

    insert(mime, gBytes, entryBuilder) {
        const semanticKey = getSemanticMimeKey(mime) || normalizeMime(mime);
        if (semanticKey) this._roots.set(semanticKey, this._root);
        const normMime = normalizeMime(mime);
        if (normMime) this._roots.set(normMime, this._root);
        const mimeKey = semanticKey;
        const totalLen = gBytes.get_size();
        const uIncoming = gBytes.get_data();
        let currNode = this._root;
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
                const leaf = new RadixNode(leafBytes, currNode, firstByte);
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

            const prefixBytes = makeSliceBytes(child.bytes, childData, 0, commonLen);
            const oldSuffixBytes = makeSliceBytes(child.bytes, childData, commonLen, childLen - commonLen);
            const splitNode = new RadixNode(prefixBytes, currNode, childData[0]);
            currNode.children.set(firstByte, splitNode);

            child.setBytes(oldSuffixBytes, childData[commonLen]);
            child.parent = splitNode;
            splitNode.children.set(childData[commonLen], child);

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
                const newLeaf = new RadixNode(newSuffixBytes, splitNode, uIncoming[offset]);
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
        const semanticKey = getSemanticMimeKey(entry.mime) || normalizeMime(entry.mime);
        const normMime = normalizeMime(entry.mime);
        if (semanticKey) {
            const count = this.#mimeEntryCounts.get(semanticKey) || 1;
            if (count <= 1) {
                this.#mimeEntryCounts.delete(semanticKey);
                this._roots.delete(semanticKey);
            } else {
                this.#mimeEntryCounts.set(semanticKey, count - 1);
            }
        }
        if (normMime && normMime !== semanticKey) {
            const count = this.#mimeEntryCounts.get(normMime) || 1;
            if (count <= 1) {
                this.#mimeEntryCounts.delete(normMime);
                this._roots.delete(normMime);
            } else {
                this.#mimeEntryCounts.set(normMime, count - 1);
            }
        }
        if (node.entries) {
            if (semanticKey) node.entries.delete(semanticKey);
            if (normMime) node.entries.delete(normMime);
            for (const [m, e] of node.entries.entries()) {
                if (e === entry) { node.entries.delete(m); break; }
            }
            node.entry = node.entries.size > 0 ? node.entries.values().next().value : null;
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

                const firstByte = n.firstByte;
                onlyChild.setBytes(mergedBytes, firstByte);
                onlyChild.parent = n.parent;
                n.parent.children.set(firstByte, onlyChild);
                tryCollapse(n.parent);
            }
        };

        let curr = node;
        while (curr && curr.parent && curr.children.size === 0 && (!curr.entries || curr.entries.size === 0) && !curr.entry) {
            const parent = curr.parent;
            parent.children.delete(curr.firstByte);
            curr = parent;
        }
        if (curr) tryCollapse(curr);
    }

    getTotalBytes() {
        let total = 0;
        const stack = [this._root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (node.bytes && typeof node.bytes.get_size === 'function') {
                total += node.bytes.get_size();
            }
            for (const child of node.children.values()) stack.push(child);
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

// ============================================================================
// 3. 多媒体与复合格式处理 (Formats & CMP1 Container)
// ============================================================================

export function detectCoreMime(mimeTypes) {
    if (!mimeTypes || mimeTypes.length === 0) return null;

    const entries = [];
    for (const raw of mimeTypes) {
        if (!raw || typeof raw !== 'string') continue;
        const base = normalizeBaseMime(raw);
        if (base) entries.push({ raw, base });
    }
    if (entries.length === 0) return null;

    const findRawCandidates = (baseList) => {
        const result = [];
        for (const targetBase of baseList) {
            for (const item of entries) {
                if (item.base === targetBase && !result.includes(item.raw)) {
                    result.push(item.raw);
                }
            }
        }
        return result;
    };

    // 1. 位图图片类
    const imgCandidates = findRawCandidates(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif']);
    if (imgCandidates.length > 0) {
        return {
            type: 'image',
            mime: imgCandidates[0],
            candidates: imgCandidates,
        };
    }

    // 2. 复制文件列表 (GNOME 与 KDE Dolphin 白名单)
    const fileCandidates = findRawCandidates(['x-special/gnome-copied-files', 'text/uri-list']);
    const kdeCutItem = entries.find(item => item.base === 'application/x-kde-cutselection' || item.base === 'x-kde-cutselection');
    if (fileCandidates.length > 0 || kdeCutItem) {
        const candidates = fileCandidates.length > 0 ? fileCandidates : ['text/uri-list'];
        return {
            type: 'files',
            mime: candidates[0],
            candidates: candidates,
            kdeCutMime: kdeCutItem ? kdeCutItem.raw : null,
        };
    }

    // 3. 复合类型与文本/HTML
    const htmlCandidates = findRawCandidates(['text/html']);
    const textCandidates = findRawCandidates(['text/plain', 'utf8_string', 'string', 'text']);

    if (htmlCandidates.length > 0 && textCandidates.length > 0) {
        return {
            type: 'composite',
            mime: 'composite',
            htmlMime: htmlCandidates[0],
            textMime: textCandidates[0],
            htmlCandidates,
            textCandidates,
        };
    }

    if (textCandidates.length > 0) {
        return {
            type: 'text',
            mime: 'text/plain',
            sourceMime: textCandidates[0],
            candidates: textCandidates,
        };
    }

    if (htmlCandidates.length > 0) {
        return {
            type: 'html',
            mime: 'text/html',
            candidates: htmlCandidates,
        };
    }

    // 4. 未知/原始二进制类型兜底
    const valid = entries
        .map(e => e.raw)
        .filter(m => {
            const b = normalizeBaseMime(m);
            return !b.startsWith('targets') && !b.startsWith('timestamp') && !b.startsWith('multiple') && !b.startsWith('delete');
        });

    if (valid.length > 0) {
        return {
            type: 'raw',
            mime: valid[0],
            candidates: valid,
        };
    }

    return null;
}

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
    } catch { return false; }
}

export function safeSlice(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    let end = maxLen;
    const code = str.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) {
        end--;
    }
    return str.slice(0, end);
}

export function getTrailingIncompleteUtf8Bytes(data) {
    const len = data.length;
    if (len === 0) return 0;
    for (let i = 1; i <= Math.min(len, 3); i++) {
        const byte = data[len - i];
        if ((byte & 0x80) === 0) return 0;
        if ((byte & 0xC0) === 0xC0) {
            let expectedLen = 0;
            if ((byte & 0xE0) === 0xC0) expectedLen = 2;
            else if ((byte & 0xF0) === 0xE0) expectedLen = 3;
            else if ((byte & 0xF8) === 0xF0) expectedLen = 4;
            if (expectedLen > i) return i;
            return 0;
        }
    }
    return 0;
}

export function extractTextPreview(gBytes, isHtml = false) {
    if (!gBytes || gBytes.get_size() === 0) return '';
    try {
        const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
        const CHUNK_SIZE = 64 * 1024;
        let text = '', clean = '';
        let carry = null;
        for (let attempt = 0; attempt < 10; attempt++) {
            const chunk = stream.read_bytes(CHUNK_SIZE, null);
            if (!chunk || chunk.get_size() === 0) break;
            let data = chunk.get_data ? chunk.get_data() : (chunk.toArray ? chunk.toArray() : chunk);
            if (carry && carry.length > 0) {
                const combined = new Uint8Array(carry.length + data.length);
                combined.set(carry, 0);
                combined.set(data, carry.length);
                data = combined;
                carry = null;
            }
            const incompleteLen = getTrailingIncompleteUtf8Bytes(data);
            if (incompleteLen > 0) {
                carry = data.slice(data.length - incompleteLen);
                data = data.subarray(0, data.length - incompleteLen);
            }
            if (data.length > 0) {
                text += Utf8Decoder.decode(data);
            }
            const raw = isHtml ? text.replace(/<[^>]+>/g, ' ') : text;
            clean = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
            if (clean) break;
        }
        if (!clean && carry && carry.length > 0) {
            text += Utf8Decoder.decode(carry);
            const raw = isHtml ? text.replace(/<[^>]+>/g, ' ') : text;
            clean = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
        }
        return clean;
    } catch { return ''; }
}

export function packCompositeBytes(parts) {
    const encoder = new TextEncoder();
    const out = Gio.MemoryOutputStream.new_resizable();
    out.write_bytes(new GLib.Bytes(new Uint8Array([0x43, 0x4D, 0x50, 0x31])), null);
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

export function unpackCompositeBytes(gBytes) {
    if (!gBytes || gBytes.get_size() < 6) return [];
    const uData = gBytes.get_data();
    if (uData[0] !== 0x43 || uData[1] !== 0x4D || uData[2] !== 0x50 || uData[3] !== 0x31) return [];
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
        parts.push({ mime, bytes: makeSliceBytes(gBytes, uData, offset, dataLen) });
        offset += dataLen;
    }
    return parts;
}

export function extractCompositePart(gBytes, targetMime) {
    if (!gBytes || gBytes.get_size() < 6) return null;
    const uData = gBytes.get_data ? gBytes.get_data() : (gBytes.toArray ? gBytes.toArray() : gBytes);
    if (uData[0] !== 0x43 || uData[1] !== 0x4D || uData[2] !== 0x50 || uData[3] !== 0x31) return null;
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
            : (normalizeBaseMime(mime) === normalizeBaseMime(targetMime) || mime === targetMime || mime.startsWith(targetMime));
        if (isMatch) return makeSliceBytes(gBytes, uData, offset, dataLen);
        offset += dataLen;
    }
    return null;
}

// ============================================================================
// 4. 预览与多语言展示 (Presentation & Preview Generator)
// ============================================================================

export function generatePreview(type, mime, gBytes, unknownTypeName = null, lang = 'zh-CN', extra = null) {
    const size = gBytes.get_size();
    const sizeStr = formatByteSize(size);
    const isEn = lang === 'en-US';

    if (type === 'composite') {
        let clean = extra?.textBytes ? extractTextPreview(extra.textBytes, false) : '';
        if (!clean) {
            const textPart = extractCompositePart(gBytes, m => ['text/plain', 'utf8_string', 'string', 'text'].includes(normalizeBaseMime(m)));
            if (textPart) clean = extractTextPreview(textPart, false);
        }
        if (!clean) {
            const htmlPart = extra?.htmlBytes || extractCompositePart(gBytes, m => normalizeBaseMime(m) === 'text/html');
            if (htmlPart) clean = extractTextPreview(htmlPart, true);
        }
        const isEmpty = !clean;
        return {
            title: clean.length > 1000 ? `${safeSlice(clean, 1000)}…` : (clean || (isEn ? '(Empty text)' : '(空文本)')),
            subtitle: `${isEn ? 'Multi-type' : '多类型'} · ${sizeStr}`,
            icon: ICON_HTML,
            isEmptyText: isEmpty,
        };
    }

    if (type === 'text' || type === 'html') {
        const clean = extractTextPreview(gBytes, false);
        const isEmpty = !clean;
        return {
            title: clean.length > 1000 ? `${safeSlice(clean, 1000)}…` : (clean || (isEn ? '(Empty text)' : '(空文本)')),
            subtitle: `${type === 'html' ? (isEn ? 'HTML' : '富文本') : (isEn ? 'Text' : '文本')} · ${sizeStr}`,
            icon: type === 'html' ? ICON_HTML : ICON_TEXT,
            isEmptyText: isEmpty,
        };
    }

    if (type === 'files') {
        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
            const MAX_SCAN_BYTES = 64 * 1024;
            const MAX_SCAN_ITEMS = 500;
            const CHUNK_SIZE = 16 * 1024;

            let totalCount = 0;
            let dirCount = 0;
            let isCapped = false;
            let name1 = null;
            let name2 = null;

            const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
            const parseName = uri => {
                if (!uri) return '';
                const clean = (uri.endsWith('/') || uri.endsWith('\\')) ? uri.slice(0, -1) : uri;
                const last = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
                return safeDecode(last >= 0 ? clean.slice(last + 1) : clean);
            };

            const processLine = rawLine => {
                const l = rawLine.trim();
                if (!l || l.startsWith('#') || l === 'copy' || l === 'cut') return;
                totalCount++;
                if (!name1) name1 = parseName(l);
                else if (!name2) name2 = parseName(l);
                if (l.endsWith('/') || l.endsWith('\\')) dirCount++;
            };

            let remainder = '';
            let scannedBytes = 0;
            let carryBytes = null;

            while (scannedBytes < MAX_SCAN_BYTES && totalCount < MAX_SCAN_ITEMS) {
                const chunk = stream.read_bytes(CHUNK_SIZE, null);
                if (!chunk || chunk.get_size() === 0) break;
                scannedBytes += chunk.get_size();

                let data = chunk.get_data ? chunk.get_data() : (chunk.toArray ? chunk.toArray() : chunk);
                if (carryBytes && carryBytes.length > 0) {
                    const combined = new Uint8Array(carryBytes.length + data.length);
                    combined.set(carryBytes, 0);
                    combined.set(data, carryBytes.length);
                    data = combined;
                    carryBytes = null;
                }

                const incompleteLen = getTrailingIncompleteUtf8Bytes(data);
                if (incompleteLen > 0) {
                    carryBytes = data.slice(data.length - incompleteLen);
                    data = data.subarray(0, data.length - incompleteLen);
                }

                const textChunk = data.length > 0 ? Utf8Decoder.decode(data) : '';
                const combinedText = remainder + textChunk;
                const lastNl = combinedText.lastIndexOf('\n');

                if (lastNl >= 0) {
                    const fullLines = combinedText.slice(0, lastNl).split('\n');
                    remainder = combinedText.slice(lastNl + 1);
                    for (const line of fullLines) {
                        processLine(line);
                        if (totalCount >= MAX_SCAN_ITEMS) {
                            isCapped = true;
                            break;
                        }
                    }
                } else {
                    remainder = combinedText;
                }
            }

            if (scannedBytes >= MAX_SCAN_BYTES || gBytes.get_size() > MAX_SCAN_BYTES) {
                isCapped = true;
            } else if (!isCapped && remainder.length > 0) {
                processLine(remainder);
            }

            if (totalCount === 0) {
                return {
                    title: isEn ? 'File List' : '文件列表',
                    subtitle: isEn ? 'Files/Folders · 0 items (path only, no disk read)' : '文件/目录 · 0 项 (仅存路径，不读内容)',
                    icon: ICON_FILES,
                    fileCountStr: '0',
                };
            }

            const countStr = isCapped ? `${totalCount}+` : `${totalCount}`;
            const isAllDir = dirCount === totalCount;
            const isMixed = dirCount > 0 && !isAllDir;
            const label = isEn ? 'Files/Folders' : '文件/目录';
            const suffix = isAllDir
                ? (isEn ? `and ${countStr} folders` : `等 ${countStr} 个文件夹`)
                : (isMixed
                    ? (isEn ? `and ${countStr} items` : `等 ${countStr} 项`)
                    : (isEn ? `and ${countStr} files` : `等 ${countStr} 个文件`));

            const title = totalCount === 1
                ? (name1 || (isEn ? 'File List' : '文件列表'))
                : (totalCount === 2 ? `${name1}, ${name2}` : `${name1}, ${name2} ${suffix}`);

            return {
                title,
                subtitle: isEn ? `${label} · ${countStr} items (path only, no disk read)` : `${label} · ${countStr} 项 (仅存路径，不读内容)`,
                icon: ICON_FILES,
                fileCountStr: countStr,
            };
        } catch {
            return {
                title: isEn ? `File List (${sizeStr})` : `文件列表 (${sizeStr})`,
                subtitle: isEn ? 'Files/Folders · (path only, no disk read)' : '文件/目录 · (仅存路径，不读内容)',
                icon: ICON_FILES,
                fileCountStr: null,
            };
        }
    }

    if (type === 'image') {
        return {
            title: isEn ? `Image (${sizeStr})` : `图片 (${sizeStr})`,
            subtitle: mime,
            icon: ICON_IMAGE,
        };
    }

    const isUnknownTag = !mime && !unknownTypeName;
    const tag = mime || unknownTypeName || (isEn ? 'Unknown Type' : '未知类型');
    return {
        title: tag.length > 200 ? `${safeSlice(tag, 200)}…` : tag,
        subtitle: sizeStr,
        icon: ICON_RAW,
        isUnknownType: isUnknownTag,
    };
}

// ============================================================================
// 5. 核心扩展类 (RawClipboardExtension)
// ============================================================================

export default class RawClipboardExtension extends Extension {
    #history = [];
    #radixTree = new RadixRawTree();
    #deletedEntries = new Set();
    #activeNonces = new Set();
    #activeTimerIds = new Set();
    #unknownTypes = new Map();
    #previewMd5ByEntry = new WeakMap();
    #iconCache = new Map();
    #thumbnailCache = new WeakMap();
    #thumbnailTasks = new Map();

    _currentReadCancellable = null;
    _undoStack = [];
    _inSearchMode = false;
    _searchQuery = '';
    _searchBar = null;
    _searchEntry = null;
    _contextMenu = null;
    _sortMode = 'queue';
    _loopArmDirection = null;

    get inSearchMode() { return this._inSearchMode; }
    get searchQuery() { return this._searchQuery; }
    get sortMode() { return this._sortMode; }
    get _lastChecksum() { return this.#history[0]?.checksum || ''; }
    get _lastHeadMd5() { return this.#history[0]?.headMd5 || ''; }
    get _lastSize() { return this.#history[0]?.size || 0; }
    get _radixTree() { return this.#radixTree; }

    get unknownTypes() {
        const map = new Map();
        for (const item of this.#history) {
            if (item.type === 'raw' && item.mime) map.set(item.mime, item.mime);
        }
        return map;
    }

    _isTextPreviewable(entry) {
        return Boolean(entry && entry.type !== 'image');
    }

    _addTimeout(intervalMs, callback, priority = GLib.PRIORITY_DEFAULT) {
        let id = 0;
        id = GLib.timeout_add(priority, intervalMs, () => {
            this.#activeTimerIds.delete(id);
            return callback();
        });
        if (id > 0) this.#activeTimerIds.add(id);
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
            if (this._settings?.settings_schema?.has_key('ui-language')) {
                return this._settings.get_string('ui-language') || 'zh-CN';
            }
        } catch {}
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
        return this._inSearchMode
            ? (isEn ? 'No matching items' : '无匹配项目')
            : (isEn ? 'Clipboard history is empty' : '剪贴板历史为空');
    }

    _getEntrySubtitle(entry) {
        if (!entry) return '';
        const isEn = this._getLanguage() === 'en-US';
        if (entry.type === 'composite') return `${isEn ? 'Multi-type' : '多类型'} · ${formatByteSize(entry.size)}`;
        if (!entry.type || entry.type === 'text' || entry.type === 'html') {
            const typeStr = entry.type === 'html' ? (isEn ? 'HTML' : '富文本') : (isEn ? 'Text' : '文本');
            return `${typeStr} · ${formatByteSize(entry.size)}`;
        }
        if (entry.type === 'image') return entry.mime || '';
        if (entry.type === 'files') {
            const countStr = entry.fileCountStr;
            if (countStr !== null && countStr !== undefined) {
                return isEn
                    ? `Files/Folders · ${countStr} items (path only, no disk read)`
                    : `文件/目录 · ${countStr} 项 (仅存路径，不读内容)`;
            }
            return isEn
                ? 'Files/Folders · (path only, no disk read)'
                : '文件/目录 · (仅存路径，不读内容)';
        }
        if (entry.type === 'unknown' || entry.type === 'raw') return formatByteSize(entry.size);
        return entry.subtitle || '';
    }

    _getEntryPreview(entry) {
        if (!entry) return '';
        const isEn = this._getLanguage() === 'en-US';
        if (entry.type === 'image') {
            return isEn ? `Image (${formatByteSize(entry.size)})` : `图片 (${formatByteSize(entry.size)})`;
        }
        if (entry.isEmptyText) {
            return isEn ? '(Empty text)' : '(空文本)';
        }
        if (entry.isUnknownType) {
            return isEn ? 'Unknown Type' : '未知类型';
        }
        return entry.preview || '';
    }

    _applyLanguage() {
        if (this._contextMenu) this._closeContextMenu();
        const isEn = this._getLanguage() === 'en-US';
        if (this._sortButtons) {
            const labels = { queue: isEn ? 'Order' : '记录顺序', size: isEn ? 'Size' : '大小', type: isEn ? 'Type' : '类型', initial: isEn ? 'A-Z' : '首字母' };
            for (const [id, btn] of this._sortButtons) {
                if (btn._labelActor) btn._labelActor.text = labels[id] || id;
            }
        }
        if (this._searchEntry && (!this._searchQuery || this._searchQuery.length === 0)) {
            this._searchEntry.set_text(this._getSearchPlaceholder());
        }
        if (this._undoLabel) this._undoLabel.text = isEn ? 'Undo' : '撤销';
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
        this._searchQuery = safeSlice(initialChar || '', MAX_SEARCH_QUERY_LEN);
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
        if (this.#deletedEntries.size === 0) return this.#history;
        return this.#history.filter(e => !this.#deletedEntries.has(e));
    }

    _getSortedEntries() {
        if (this._inSearchMode) {
            const query = (this._searchQuery || '').trim().toLowerCase();
            if (query.length === 0) return [];
            return this._getVisibleEntries().filter(entry => {
                if (!this._isTextPreviewable(entry)) return false;
                const p1 = (entry.preview || '').toLowerCase();
                const p2 = this._getEntryPreview(entry).toLowerCase();
                return p1.includes(query) || p2.includes(query);
            });
        }

        const visible = this._getVisibleEntries();
        if (this._sortMode === 'queue' || visible.length <= 1) return visible;

        const orderMap = new Map();
        visible.forEach((entry, idx) => orderMap.set(entry, idx));
        const copy = [...visible];

        if (this._sortMode === 'size') {
            copy.sort((a, b) => {
                const sA = typeof a.size === 'number' ? a.size : (a.bytes ? a.bytes.get_size() : 0);
                const sB = typeof b.size === 'number' ? b.size : (b.bytes ? b.bytes.get_size() : 0);
                return sB !== sA ? sB - sA : orderMap.get(a) - orderMap.get(b);
            });
        } else if (this._sortMode === 'type') {
            const rank = { text: 1, composite: 2, html: 3, files: 4, image: 5, raw: 6 };
            copy.sort((a, b) => {
                const rA = rank[a.type] || 99, rB = rank[b.type] || 99;
                return rA !== rB ? rA - rB : orderMap.get(a) - orderMap.get(b);
            });
        } else if (this._sortMode === 'initial') {
            const getInit = str => {
                if (!str || typeof str !== 'string') return null;
                const t = str.trim();
                if (!t) return null;
                const c = t[0];
                return ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) ? c.toUpperCase() : null;
            };
            copy.sort((a, b) => {
                const initA = getInit(a.preview), initB = getInit(b.preview);
                if (initA && initB) {
                    if (initA !== initB) return initA.localeCompare(initB);
                    const cmp = a.preview.localeCompare(b.preview, 'en', { sensitivity: 'base' });
                    return cmp !== 0 ? cmp : orderMap.get(a) - orderMap.get(b);
                }
                if (initA && !initB) return -1;
                if (!initA && initB) return 1;
                return orderMap.get(a) - orderMap.get(b);
            });
        }
        return copy;
    }

    _setSortMode(mode) {
        if (this._sortMode === mode) return;
        this._sortMode = mode;
        if (this._sortButtons) {
            this._sortButtons.forEach((btn, id) => {
                if (id === mode) btn.add_style_class_name('active');
                else btn.remove_style_class_name('active');
            });
        }
        this._loopArmDirection = null;
        this._currentPage = 0;
        this._selectedIndex = 0;
        if (this._popup?.visible) {
            this._renderPage();
            this._updatePageBadge();
        }
    }

    _isLoggingEnabled() {
        return Boolean(this._settings?.get_boolean('enable-logging'));
    }

    _log(...args) {
        if (this._isLoggingEnabled()) console.log(...this._formatLogArgs(args));
    }
    _debug(...args) { this._log(...args); }
    _warn(...args) { this._log(...args); }
    _error(...args) { this._log(...args); }

    _formatLogArgs(args) {
        if (args.length === 0) return ['[RawClipboard]'];
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[RawClipboard]')) return args;
        return ['[RawClipboard]', ...args];
    }

    _formatEntryLog(entry) {
        if (!entry) return '[空条目]';
        if (!this._isLoggingEnabled()) return '';
        const id = entry.id || 'unknown';
        const type = entry.type || 'unknown';
        const size = typeof entry.size === 'number' ? entry.size : (entry.bytes?.get_size ? entry.bytes.get_size() : 0);
        if (entry.type === 'image' || entry.type === 'raw' || !entry.preview) {
            return `[条目#${id} (${type}, ${size}B)]`;
        }
        let md5 = null;
        try { md5 = this.#previewMd5ByEntry.get(entry); } catch {}
        if (!md5) {
            try {
                md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, entry.preview, -1).slice(0, 8);
                try { this.#previewMd5ByEntry.set(entry, md5); } catch {}
            } catch { md5 = 'none'; }
        }
        return `[条目#${id} (MD5:${md5}, ${type}, ${size}B)]`;
    }

    _getUnknownTypeName(mime) {
        return mime || (this._getLanguage() === 'en-US' ? 'Unknown Type' : '未知类型');
    }

    _getEntry(index) {
        return this.#history[index] || null;
    }

    _getRadixNode(entry) {
        return this.#radixTree ? this.#radixTree.getNode(entry) : null;
    }

    // 统一 Entry 实体工厂构建逻辑，消除 _onClipboardOwnerChanged 与 _convertEntry 的双重重复
    _buildEntry(leafNode, core, gBytes, size, copyTime, compositeExtra = null) {
        const thisRef = this;
        const isEn = this._getLanguage() === 'en-US';
        const unknownLabel = (core.type === 'raw') ? this._getUnknownTypeName(core.mime) : null;
        const previewInfo = generatePreview(core.type, core.mime, gBytes, unknownLabel, this._getLanguage(), compositeExtra);
        let cachedThumb = undefined;
        let cachedChecksum = null;
        let entryTime = copyTime;

        const entryFormats = [];
        let entryRef = null;

        if (core.type === 'composite') {
            entryFormats.push({
                mime: core.htmlMime || 'text/html',
                type: 'html',
                icon: ICON_HTML,
                label: isEn ? 'HTML' : '富文本',
                get bytes() { return entryRef.htmlBytes; },
            });
            entryFormats.push({
                mime: core.textMime || 'text/plain',
                type: 'text',
                icon: ICON_TEXT,
                label: isEn ? 'Text' : '纯文本',
                get bytes() { return entryRef.textBytes; },
            });
        } else if (core.type === 'text') {
            entryFormats.push({
                mime: core.mime,
                type: 'text',
                icon: ICON_TEXT,
                label: isEn ? 'Text' : '纯文本',
                get bytes() { return entryRef.bytes; },
            });
        } else if (core.type === 'html') {
            entryFormats.push({
                mime: core.mime || 'text/html',
                type: 'html',
                icon: ICON_HTML,
                label: isEn ? 'HTML' : '富文本',
                get bytes() { return entryRef.bytes; },
            });
        } else if (core.type === 'files') {
            entryFormats.push({
                mime: core.mime,
                type: 'files',
                icon: ICON_FILES,
                label: isEn ? 'Files/Folders' : '文件/目录',
                get bytes() { return entryRef.bytes; },
            });
        } else if (core.type === 'image') {
            entryFormats.push({
                mime: core.mime,
                type: 'image',
                icon: ICON_IMAGE,
                label: isEn ? 'Image' : '图片',
                get bytes() { return entryRef.bytes; },
            });
        } else {
            entryFormats.push({
                mime: core.mime,
                type: 'raw',
                icon: ICON_RAW,
                label: unknownLabel || (isEn ? 'Unknown' : '未知类型'),
                get bytes() { return entryRef.bytes; },
            });
        }

        entryRef = Object.freeze({
            id: `${copyTime}_${Math.floor(Math.random() * 1000)}`,
            type: core.type,
            mime: core.mime,
            size: size,
            formats: Object.freeze(entryFormats),
            get bytes() {
                const segs = leafNode.collectPathSegments();
                if (segs.length === 1) return segs[0];
                const out = Gio.MemoryOutputStream.new_resizable();
                for (const s of segs) out.write_bytes(s, null);
                out.close(null);
                return out.steal_as_bytes();
            },
            get checksum() {
                if (!cachedChecksum) cachedChecksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, this.bytes);
                return cachedChecksum;
            },
            get parts() {
                if (core.type === 'composite') return unpackCompositeBytes(this.bytes);
                return [{ mime: core.mime, bytes: this.bytes }];
            },
            get htmlBytes() {
                if (core.type === 'composite') {
                    return extractCompositePart(this.bytes, m => normalizeBaseMime(m) === 'text/html');
                }
                return null;
            },
            get textBytes() {
                if (core.type === 'composite') {
                    return extractCompositePart(this.bytes, m => ['text/plain', 'utf8_string', 'string', 'text'].includes(normalizeBaseMime(m)));
                }
                return null;
            },
            get thumbIcon() {
                if (core.type === 'image') {
                    if (thisRef.#thumbnailCache.has(entryRef)) {
                        return thisRef.#thumbnailCache.get(entryRef);
                    }
                    return thisRef._getThumbnail(entryRef, this.bytes, core.mime);
                }
                return null;
            },
            preview: previewInfo.title,
            subtitle: previewInfo.subtitle,
            icon: previewInfo.icon,
            fileCountStr: previewInfo.fileCountStr || null,
            isEmptyText: previewInfo.isEmptyText || false,
            isUnknownType: previewInfo.isUnknownType || false,
            get time() { return entryTime; },
            set time(val) { if (typeof val === 'number') entryTime = val; },
        });

        if (core.type === 'image') {
            thisRef._ensureThumbnail(entryRef, gBytes, core.mime);
        }

        return entryRef;
    }

    enable() {
        this._settings = this.getSettings();
        this.#history = [];
        this.#radixTree = new RadixRawTree();
        this.#deletedEntries.clear();
        this.#unknownTypes.clear();
        this.#activeNonces.clear();
        this.#thumbnailTasks.clear();
        this.#thumbnailCache = new WeakMap();
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
        this._isRestoring = false;

        this._selection = global.display.get_selection();
        this._selectionOwnerId = this._selection.connect('owner-changed', this._onClipboardOwnerChanged.bind(this));

        this._settingsChangedId = this._settings.connect('changed::max-items', this._enforceLimit.bind(this));
        this._maxSizeChangedId = this._settings.connect('changed::max-size-mb', this._enforceLimit.bind(this));
        this._totalSizeChangedId = this._settings.connect('changed::max-total-size-mb', this._enforceLimit.bind(this));
        this._shortcutChangedId = this._settings.connect('changed::toggle-shortcut', this._bindShortcut.bind(this));
        this._langChangedId = this._settings.connect('changed::ui-language', () => {
            if (this._container) this._applyLanguage();
        });

        if (Main.sessionMode) {
            this._sessionUpdatedId = Main.sessionMode.connect('updated', () => {
                if (Main.sessionMode.isLocked && this._container) this._closePopup();
            });
        }

        this._bindShortcut();
        this._log('[RawClipboard] 扩展已启用');
    }

    disable() {
        this._log('[RawClipboard] 扩展已禁用，清理监听与状态');
        if (this._hasKeybinding) {
            Main.wm.removeKeybinding('toggle-shortcut');
            this._hasKeybinding = false;
        }
        if (this._currentReadCancellable) {
            this._currentReadCancellable.cancel();
            this._currentReadCancellable = null;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._renderIdleId) {
            GLib.source_remove(this._renderIdleId);
            this._renderIdleId = 0;
        }
        for (const timerId of this.#activeTimerIds) {
            try { GLib.source_remove(timerId); } catch {}
        }
        this.#activeTimerIds.clear();

        if (this._settings) {
            if (this._settingsChangedId >= 0) this._settings.disconnect(this._settingsChangedId);
            if (this._maxSizeChangedId >= 0) this._settings.disconnect(this._maxSizeChangedId);
            if (this._totalSizeChangedId >= 0) this._settings.disconnect(this._totalSizeChangedId);
            if (this._shortcutChangedId >= 0) this._settings.disconnect(this._shortcutChangedId);
            if (this._langChangedId >= 0) this._settings.disconnect(this._langChangedId);
        }
        if (this._sessionUpdatedId && Main.sessionMode) {
            Main.sessionMode.disconnect(this._sessionUpdatedId);
            this._sessionUpdatedId = 0;
        }
        if (this._selectionOwnerId >= 0) {
            this._selection.disconnect(this._selectionOwnerId);
            this._selectionOwnerId = -1;
        }

        this._destroyPopupUI();
        this.#deletedEntries.clear();
        this._undoStack = [];
        this.#history = [];
        this.#radixTree.clear();
        this.#unknownTypes.clear();
        this.#activeNonces.clear();
        this.#iconCache.clear();
        this._cancelAllThumbnailTasks();
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
        if (!shortcuts || shortcuts.length === 0 || !shortcuts[0]) return;

        const flags = Meta.KeyBindingFlags?.IGNORE_AUTOREPEAT || Meta.KeyBindingFlags.NONE;
        const modes = (Shell.ActionMode?.NORMAL || 1) | (Shell.ActionMode?.OVERVIEW || 2) | (Shell.ActionMode?.POPUP || 128);

        const action = Main.wm.addKeybinding('toggle-shortcut', this._settings, flags, modes, () => this._togglePopup());
        this._hasKeybinding = (action !== 0 && (!Meta.KeyBindingAction || action !== Meta.KeyBindingAction.NONE));
    }

    _cancelThumbnailTask(entry) {
        if (!entry) return;
        const task = this.#thumbnailTasks.get(entry);
        if (task) {
            this.#thumbnailTasks.delete(entry);
            if (typeof task === 'number') {
                try { GLib.source_remove(task); } catch {}
            } else if (task && typeof task.dispose === 'function') {
                task.dispose();
            }
        }
    }

    _cancelAllThumbnailTasks() {
        for (const [, task] of this.#thumbnailTasks) {
            if (typeof task === 'number') {
                try { GLib.source_remove(task); } catch {}
            } else if (task && typeof task.dispose === 'function') {
                task.dispose();
            }
        }
        this.#thumbnailTasks.clear();
    }

    _getMaxThumbnailDim() {
        let maxDim = 4096;
        try {
            if (this._settings?.settings_schema?.has_key('max-thumbnail-dimension')) {
                maxDim = this._settings.get_int('max-thumbnail-dimension');
            }
        } catch {}
        return maxDim;
    }

    _setupThumbnailLoader(mime, maxDim, fileSize) {
        const BITMAP_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
        if (!BITMAP_MIMES.includes(mime)) return null;

        let loader = null;
        try { loader = GdkPixbuf.PixbufLoader.new_with_mime_type(mime); } catch { return null; }

        const state = {
            loader,
            exceeded: false,
            sizePrepared: false,
            maxMemoryLimit: 0,
            origW: 0,
            origH: 0,
        };

        loader.connect('size-prepared', (l, w, h) => {
            state.sizePrepared = true;
            state.origW = w; state.origH = h;
            if (w <= 0 || h <= 0 || w > maxDim || h > maxDim || (w * h) > maxDim * maxDim) {
                state.exceeded = true;
                l.set_size(1, 1);
                return;
            }
            if (w > 64 || h > 64) {
                let destW = 64, destH = 64;
                if (w > h) destH = Math.max(1, Math.round((h * 64) / w));
                else destW = Math.max(1, Math.round((w * 64) / h));
                l.set_size(destW, destH);
            }
        });

        loader.connect('area-prepared', (l) => {
            const pix = l.get_pixbuf();
            if (pix) {
                const channels = pix.get_n_channels ? pix.get_n_channels() : 4;
                const bits = pix.get_bits_per_sample ? pix.get_bits_per_sample() : 8;
                const bpp = channels * Math.ceil(bits / 8);
                state.maxMemoryLimit = state.origW * state.origH * bpp;
                if (fileSize > (state.maxMemoryLimit + 1048576)) {
                    state.exceeded = true;
                    return;
                }
                const byteLen = pix.get_byte_length ? pix.get_byte_length() : 0;
                const rowstride = pix.get_rowstride ? pix.get_rowstride() : (pix.get_width() * bpp);
                if (byteLen > rowstride * pix.get_height()) state.exceeded = true;
            }
        });

        return state;
    }

    _finishThumbnailLoader(state) {
        try { state.loader.close(); } catch {}
        if (state.exceeded || !state.sizePrepared) return null;
        try {
            const pixbuf = state.loader.get_pixbuf();
            if (!pixbuf) return null;
            const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
            if (!ok) return null;
            return Gio.BytesIcon.new(new GLib.Bytes(buffer));
        } catch { return null; }
    }

    _generateThumbnail(gBytes, mime, maxDim = 4096) {
        const fileSize = gBytes?.get_size ? gBytes.get_size() : 0;
        const state = this._setupThumbnailLoader(mime, maxDim, fileSize);
        if (!state) return null;

        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
            const CHUNK = 64 * 1024;
            let totalFed = 0;
            while (!state.exceeded) {
                const chunk = stream.read_bytes(CHUNK, null);
                if (!chunk || chunk.get_size() === 0) break;
                totalFed += chunk.get_size();
                if (state.sizePrepared && state.maxMemoryLimit > 0 && totalFed > (state.maxMemoryLimit + 1048576)) {
                    state.exceeded = true;
                    break;
                }
                state.loader.write_bytes(chunk);
            }
        } catch {}

        return this._finishThumbnailLoader(state);
    }

    _startIdleThumbnailTask(entry, gBytes, mime, maxDim) {
        if (this.#thumbnailTasks.has(entry)) return;
        const fileSize = gBytes?.get_size ? gBytes.get_size() : 0;
        const state = this._setupThumbnailLoader(mime, maxDim, fileSize);
        if (!state) {
            this.#thumbnailCache.set(entry, null);
            return;
        }

        const stream = Gio.MemoryInputStream.new_from_bytes(gBytes);
        const CHUNK = 64 * 1024;
        let totalFed = 0;

        const task = {
            sourceId: 0,
            stream,
            loader: state.loader,
            dispose() {
                if (this.sourceId > 0) {
                    try { GLib.source_remove(this.sourceId); } catch {}
                    this.sourceId = 0;
                }
                try { this.stream.close(null); } catch {}
                try { this.loader.close(); } catch {}
            }
        };

        task.sourceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (!this.#thumbnailTasks.has(entry) || this.#thumbnailTasks.get(entry) !== task) {
                task.dispose();
                return GLib.SOURCE_REMOVE;
            }

            try {
                for (let i = 0; i < 2; i++) {
                    if (state.exceeded) break;
                    const chunk = stream.read_bytes(CHUNK, null);
                    if (!chunk || chunk.get_size() === 0) {
                        this.#thumbnailTasks.delete(entry);
                        task.dispose();
                        const icon = this._finishThumbnailLoader(state);
                        this.#thumbnailCache.set(entry, icon);
                        if (icon) this._onThumbnailReady(entry, icon);
                        return GLib.SOURCE_REMOVE;
                    }
                    totalFed += chunk.get_size();
                    if (state.sizePrepared && state.maxMemoryLimit > 0 && totalFed > (state.maxMemoryLimit + 1048576)) {
                        state.exceeded = true;
                        break;
                    }
                    state.loader.write_bytes(chunk);
                }

                if (state.exceeded) {
                    this.#thumbnailTasks.delete(entry);
                    task.dispose();
                    this.#thumbnailCache.set(entry, null);
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            } catch {
                this.#thumbnailTasks.delete(entry);
                task.dispose();
                this.#thumbnailCache.set(entry, null);
                return GLib.SOURCE_REMOVE;
            }
        });

        this.#thumbnailTasks.set(entry, task);
    }

    _ensureThumbnail(entry, gBytes, mime) {
        if (!entry || !gBytes || this.#thumbnailCache.has(entry) || this.#thumbnailTasks.has(entry)) {
            return;
        }
        const maxDim = this._getMaxThumbnailDim();
        const size = gBytes.get_size ? gBytes.get_size() : 0;
        if (size <= 64 * 1024) {
            const icon = this._generateThumbnail(gBytes, mime, maxDim);
            this.#thumbnailCache.set(entry, icon);
        } else {
            this._startIdleThumbnailTask(entry, gBytes, mime, maxDim);
        }
    }

    _getThumbnail(entry, gBytes, mime) {
        if (!entry) return null;
        if (this.#thumbnailCache.has(entry)) {
            return this.#thumbnailCache.get(entry);
        }
        this._ensureThumbnail(entry, gBytes, mime);
        return this.#thumbnailCache.get(entry) || null;
    }

    _onThumbnailReady(entry, icon) {
        if (!this._container || !this._itemSlots) return;
        for (const slot of this._itemSlots) {
            if (slot.currentEntry === entry) {
                this._applySlotIcon(slot);
                break;
            }
        }
    }

    _queueRender() {
        if (this._renderIdleId) return;
        this._renderIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._renderIdleId = 0;
            if (this._popup?.visible) {
                this._renderPage();
                this._updatePageBadge();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    async _readCandidateStream(selectionSource, candidates, readCancellable, inactivityTimeoutMs, maxPayloadBytes, currentTotalRead = 0) {
        if (!candidates || candidates.length === 0) return null;

        for (const mime of candidates) {
            if (readCancellable.is_cancelled() || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                return null;
            }

            const candidateCancellable = new Gio.Cancellable();
            const linkId = readCancellable.connect(() => candidateCancellable.cancel());
            let watchdogId = 0;

            const resetWatchdog = () => {
                if (watchdogId > 0) {
                    this._removeTimeout(watchdogId);
                    watchdogId = 0;
                }
                if (candidateCancellable.is_cancelled()) return;
                watchdogId = this._addTimeout(inactivityTimeoutMs, () => {
                    watchdogId = 0;
                    candidateCancellable.cancel();
                    return GLib.SOURCE_REMOVE;
                });
            };

            let inputStream = null;
            let outputStream = null;
            let isOversized = false;

            try {
                resetWatchdog();
                inputStream = await callAsync(selectionSource, 'read_async', 'read_finish', mime, candidateCancellable);
                resetWatchdog();

                outputStream = Gio.MemoryOutputStream.new_resizable();
                const CHUNK_SIZE = 64 * 1024;
                let totalRead = currentTotalRead;

                let reachedEof = false;

                while (true) {
                    if (candidateCancellable.is_cancelled() || readCancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) break;
                    const bytes = await callAsync(inputStream, 'read_bytes_async', 'read_bytes_finish', CHUNK_SIZE, GLib.PRIORITY_DEFAULT, candidateCancellable);
                    const chunkSize = bytes ? bytes.get_size() : 0;
                    if (chunkSize === 0) {
                        reachedEof = true;
                        break;
                    }

                    totalRead += chunkSize;
                    if (totalRead > maxPayloadBytes) {
                        isOversized = true;
                        candidateCancellable.cancel();
                        break;
                    }
                    outputStream.write_bytes(bytes, null);
                    resetWatchdog();
                }

                if (isOversized) {
                    return { isOversized: true, mime, bytes: null };
                }

                if (candidateCancellable.is_cancelled() || readCancellable.is_cancelled() || !reachedEof || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                    return null;
                }

                if (outputStream && !outputStream.is_closed()) {
                    outputStream.close(null);
                    const resBytes = outputStream.steal_as_bytes();
                    if (resBytes && resBytes.get_size() > 0) {
                        return { isOversized: false, mime, bytes: resBytes, size: resBytes.get_size() };
                    }
                }
            } catch (e) {
                if (readCancellable.is_cancelled() || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                    return null;
                }
            } finally {
                if (watchdogId > 0) {
                    this._removeTimeout(watchdogId);
                    watchdogId = 0;
                }
                if (linkId > 0) {
                    readCancellable.disconnect(linkId);
                }
                if (inputStream) { try { inputStream.close(null); } catch {} }
                if (outputStream && !outputStream.is_closed()) { try { outputStream.close(null); } catch {} }
            }
        }

        return null;
    }

    async _readMimeStream(selectionSource, mime, readCancellable, resetWatchdog, maxPayloadBytes, currentTotalRead = 0) {
        let inactivityTimeoutMs = this._inactivityTimeoutMs !== undefined ? this._inactivityTimeoutMs : INACTIVITY_TIMEOUT_MS;
        if (this._settings) {
            try {
                const sec = this._settings.get_int('inactivity-timeout-sec');
                if (sec > 0 && this._inactivityTimeoutMs === undefined) inactivityTimeoutMs = sec * 1000;
            } catch {}
        }
        const res = await this._readCandidateStream(selectionSource, [mime], readCancellable, inactivityTimeoutMs, maxPayloadBytes, currentTotalRead);
        if (res && res.isOversized) return { isOversized: true, bytes: null };
        return { isOversized: false, bytes: res?.bytes || null };
    }

    async _onClipboardOwnerChanged(_selection, selectionType, selectionSource) {
        if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
        const copyTime = Date.now();
        if (!this._cancellable || this._cancellable.is_cancelled()) return;

        // 守卫 3: 抢占式守卫
        if (this._currentReadCancellable && !this._currentReadCancellable.is_cancelled()) {
            this._currentReadCancellable.cancel();
            this._currentReadCancellable = null;
        }

        if (!selectionSource) return;

        // 自发回灌回环识别
        const sourceNonce = selectionSource ? selectionSource[RESTORE_NONCE] : null;
        if (sourceNonce && this.#activeNonces.has(sourceNonce)) {
            this.#activeNonces.delete(sourceNonce);
            return;
        }
        if (this._isRestoring) return;

        const readCancellable = new Gio.Cancellable();
        this._currentReadCancellable = readCancellable;
        const boundSettings = this._settings;
        const boundCancellable = this._cancellable;

        let parentCancelId = 0, overallTimeoutId = 0, overallSettingsChangedId = 0;
        const overallStartTime = Date.now();

        try {
            if (boundCancellable) {
                parentCancelId = boundCancellable.connect(() => readCancellable.cancel());
            }

            let inactivityTimeoutMs = this._inactivityTimeoutMs !== undefined ? this._inactivityTimeoutMs : INACTIVITY_TIMEOUT_MS;
            let overallTimeoutMs = this._overallTimeoutMs !== undefined ? this._overallTimeoutMs : OVERALL_TIMEOUT_MS;

            if (boundSettings) {
                try {
                    const sec1 = boundSettings.get_int('inactivity-timeout-sec');
                    if (sec1 > 0 && this._inactivityTimeoutMs === undefined) inactivityTimeoutMs = sec1 * 1000;
                    const sec2 = boundSettings.get_int('overall-timeout-sec');
                    if (sec2 > 0 && this._overallTimeoutMs === undefined) overallTimeoutMs = sec2 * 1000;
                } catch {}
            }

            // 总体硬超时守卫
            const scheduleOverallTimeout = (timeoutMs) => {
                if (overallTimeoutId > 0) { this._removeTimeout(overallTimeoutId); overallTimeoutId = 0; }
                const elapsedMs = Date.now() - overallStartTime;
                if (elapsedMs >= timeoutMs) {
                    readCancellable.cancel();
                    return;
                }
                overallTimeoutId = this._addTimeout(timeoutMs - elapsedMs, () => {
                    overallTimeoutId = 0;
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
                            if (sec > 0) scheduleOverallTimeout(sec * 1000);
                        } catch {}
                    });
                } catch {}
            }

            const mimeTypes = selectionSource.get_mimetypes ? selectionSource.get_mimetypes() : [];
            const core = detectCoreMime(mimeTypes);
            if (!core) return;

            const maxMb = this._settings ? this._settings.get_int('max-size-mb') : 50;
            const maxPayloadBytes = Math.max(5, Math.min(1024, maxMb)) * 1024 * 1024;

            let gBytes = null, size = 0, compositeParts = null;

            // KDE 剪切文件精准拦截 (标记 1 为剪切，0 为普通复制)
            if (core.type === 'files' && core.kdeCutMime) {
                const kdeRes = await this._readCandidateStream(selectionSource, [core.kdeCutMime], readCancellable, inactivityTimeoutMs, 1024, 0);
                if (kdeRes && kdeRes.bytes && kdeRes.bytes.get_size() > 0) {
                    const kdeData = kdeRes.bytes.get_data ? kdeRes.bytes.get_data() : (kdeRes.bytes.toArray ? kdeRes.bytes.toArray() : kdeRes.bytes);
                    const kdeStr = Utf8Decoder.decode(kdeData).trim();
                    if (kdeStr === '1' || kdeStr.startsWith('1')) {
                        this._log?.('[RawClipboard] 成功拦截 KDE 剪切文件操作 (application/x-kde-cutselection = 1)');
                        return;
                    }
                }
            }

            if (core.type === 'composite') {
                // 先读纯文本候选流（体积小、速度快、稳定性高）
                const textRes = await this._readCandidateStream(
                    selectionSource,
                    core.textCandidates || [core.textMime],
                    readCancellable,
                    inactivityTimeoutMs,
                    maxPayloadBytes,
                    0
                );
                const textBytes = (textRes && !textRes.isOversized && textRes.bytes && textRes.bytes.get_size() > 0)
                    ? textRes.bytes
                    : null;

                // 再读 HTML 候选流（累积已读取的文本大小统计上限）
                const htmlAccumulated = textBytes ? textBytes.get_size() : 0;
                const htmlRes = await this._readCandidateStream(
                    selectionSource,
                    core.htmlCandidates || [core.htmlMime],
                    readCancellable,
                    inactivityTimeoutMs,
                    maxPayloadBytes,
                    htmlAccumulated
                );
                const htmlBytes = (htmlRes && !htmlRes.isOversized && htmlRes.bytes && htmlRes.bytes.get_size() > 0)
                    ? htmlRes.bytes
                    : null;

                if (readCancellable.is_cancelled() || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                    return;
                }

                // 优雅降级决策：双路均成功则封装复合条目；任一路失败/空则降级为单格式条目，杜绝整条丢弃
                if (htmlBytes && textBytes) {
                    core.htmlMime = htmlRes.mime || core.htmlMime || 'text/html';
                    core.textMime = textRes.mime || core.textMime || 'text/plain';
                    compositeParts = [
                        { mime: core.htmlMime, bytes: htmlBytes },
                        { mime: core.textMime, bytes: textBytes },
                    ];
                    gBytes = packCompositeBytes(compositeParts);
                    size = htmlBytes.get_size() + textBytes.get_size();
                } else if (htmlBytes && !textBytes) {
                    core.type = 'html';
                    core.mime = htmlRes.mime || 'text/html';
                    gBytes = htmlBytes;
                    size = htmlBytes.get_size();
                } else if (!htmlBytes && textBytes) {
                    core.type = 'text';
                    core.mime = 'text/plain';
                    core.sourceMime = textRes.mime || 'text/plain';
                    gBytes = textBytes;
                    size = textBytes.get_size();
                } else {
                    return;
                }
            } else {
                const candidates = core.candidates || [core.sourceMime || core.mime];
                const res = await this._readCandidateStream(
                    selectionSource,
                    candidates,
                    readCancellable,
                    inactivityTimeoutMs,
                    maxPayloadBytes,
                    0
                );
                if (!res || res.isOversized || !res.bytes || res.bytes.get_size() === 0) return;
                if (readCancellable.is_cancelled() || !this._cancellable || this._cancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                    return;
                }
                gBytes = res.bytes;
                size = gBytes.get_size();
                if (res.mime) {
                    core.mime = res.mime;
                    if (core.type === 'text') {
                        core.sourceMime = res.mime;
                    }
                }
            }

            // 严格拦截剪切文件操作 (GNOME Nautilus cut 标记)
            if (core.type === 'files' && isFileCutOperation(gBytes)) return;

            if (!this._cancellable || this._cancellable.is_cancelled() || readCancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                return;
            }

            // 投递前缀树与查重
            const insertResult = this.#radixTree.insert(core.mime, gBytes, leafNode => {
                const extra = compositeParts ? { textBytes: compositeParts[1]?.bytes, htmlBytes: compositeParts[0]?.bytes } : null;
                return this._buildEntry(leafNode, core, gBytes, size, copyTime, extra);
            });

            if (insertResult.isDuplicate) {
                if (!this._cancellable || this._cancellable.is_cancelled() || readCancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                    return;
                }
                const existing = insertResult.existingEntry;
                try { existing.time = copyTime; } catch {}

                if (this.#deletedEntries.has(existing)) {
                    this.#deletedEntries.delete(existing);
                    this._undoStack = this._undoStack.filter(e => e !== existing);
                    this._updateUndoButton();
                }

                const existingIdx = this.#history.indexOf(existing);
                if (existingIdx !== 0) {
                    if (existingIdx > 0) this.#history.splice(existingIdx, 1);
                    this.#history.unshift(existing);
                    this._log(`[RawClipboard] 命中历史相同条目，LRU 提升至队首: ${this._formatEntryLog(existing)}`);
                }
                if (this._popup?.visible) this._queueRender();
                return;
            }

            if (!this._cancellable || this._cancellable.is_cancelled() || readCancellable.is_cancelled() || this._currentReadCancellable !== readCancellable) {
                this.#radixTree.remove(insertResult.newEntry);
                return;
            }

            this.#history.unshift(insertResult.newEntry);
            this._log(`[RawClipboard] 成功记录新剪贴板条目: ${this._formatEntryLog(insertResult.newEntry)}，当前历史总数: ${this.#history.length}`);
            this._enforceLimit();
            if (this._popup?.visible) this._queueRender();
        } catch (e) {
            if (readCancellable.is_cancelled() || (e.matches && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))) return;
            this._warn('[RawClipboard] Capture error:', e.message);
        } finally {
            if (overallSettingsChangedId > 0 && boundSettings) {
                try { boundSettings.disconnect(overallSettingsChangedId); } catch {}
            }
            if (overallTimeoutId > 0) this._removeTimeout(overallTimeoutId);
            if (parentCancelId > 0 && boundCancellable) {
                try { boundCancellable.disconnect(parentCancelId); } catch {}
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

        const purgeItem = (item) => {
            this._cancelThumbnailTask(item);
            this.#radixTree.remove(item);
            if (this.#deletedEntries.has(item)) {
                this.#deletedEntries.delete(item);
                this._undoStack = this._undoStack.filter(e => e !== item);
            }
        };

        // 1. 单项容量上限裁剪
        for (let i = this.#history.length - 1; i >= 0; i--) {
            const item = this.#history[i];
            const size = typeof item.size === 'number' ? item.size : (item.bytes?.get_size ? item.bytes.get_size() : 0);
            if (size > maxSingleBytes) {
                this._log(`[RawClipboard] 条目超出单项容量限制 (${rawMaxMb} MB)，移除该条目: ${this._formatEntryLog(item)}`);
                this.#history.splice(i, 1);
                purgeItem(item);
            }
        }

        // 2. 条数上限裁剪 (FIFO)
        while (this.#history.length > maxItems) {
            const popped = this.#history.pop();
            if (popped) {
                this._log(`[RawClipboard] 超过最大历史条数限制 (${maxItems} 条)，淘汰最旧条目: ${this._formatEntryLog(popped)}`);
                purgeItem(popped);
            }
        }

        // 3. 全局总内存上限裁剪 (FIFO) - 依据前缀树实际物理内存占用判定配额，充分发挥前缀复用节省优势
        const getPhysicalBytes = () => {
            if (this.#radixTree && typeof this.#radixTree.getTotalBytes === 'function') {
                return this.#radixTree.getTotalBytes();
            }
            return this.#history.reduce((sum, item) => sum + (typeof item.size === 'number' ? item.size : (item.bytes?.get_size ? item.bytes.get_size() : 0)), 0);
        };
        let totalBytes = getPhysicalBytes();

        while (this.#history.length > 0 && totalBytes > maxTotalBytes) {
            const popped = this.#history.pop();
            if (popped) {
                this._log(`[RawClipboard] 超过历史总内存上限 (${maxTotalMb} MB)，淘汰最旧条目: ${this._formatEntryLog(popped)}`);
                purgeItem(popped);
                totalBytes = getPhysicalBytes();
            }
        }

        this._updateUndoButton();
        if (this._popup?.visible) this._queueRender();
    }

    _restoreEntryFormat(entry, targetMime = null) {
        const entrySize = typeof entry?.size === 'number' ? entry.size : (entry?.bytes?.get_size ? entry.bytes.get_size() : 0);
        if (entrySize <= 0) return;
        const selectedMime = targetMime || ((entry.type === 'composite')
            ? (entry.formats?.[0]?.mime || entry.htmlMime || 'text/html')
            : (entry.formats?.[0]?.mime || entry.mime));

        try {
            const nonce = GLib.uuid_string_random();
            this.#activeNonces.add(nonce);
            this._addTimeout(500, () => {
                this.#activeNonces.delete(nonce);
                return GLib.SOURCE_REMOVE;
            });

            this._isRestoring = true;
            try {
                let source = null, mime = selectedMime, contentBytes = null;
                if (entry.type === 'composite') {
                    const baseSelected = normalizeBaseMime(mime);
                    if (baseSelected === 'text/html' || baseSelected.includes('html')) {
                        mime = entry.htmlMime || selectedMime || 'text/html';
                        contentBytes = entry.htmlBytes || entry.bytes;
                    } else if (baseSelected === 'text/plain' || ['text/plain', 'utf8_string', 'string', 'text'].includes(baseSelected)) {
                        mime = entry.textMime || selectedMime || 'text/plain';
                        contentBytes = entry.textBytes;
                        if (!contentBytes || contentBytes.get_size() === 0) {
                            const htmlBytes = entry.htmlBytes || entry.bytes;
                            if (htmlBytes && htmlBytes.get_size() > 0) {
                                const plainText = extractTextPreview(htmlBytes, true);
                                if (plainText && plainText.length > 0) {
                                    contentBytes = new GLib.Bytes(new TextEncoder().encode(plainText));
                                }
                            }
                        }
                        if (!contentBytes) contentBytes = entry.bytes;
                    } else {
                        contentBytes = extractCompositePart(entry.bytes, mime) || entry.bytes;
                    }
                } else {
                    contentBytes = entry.bytes;
                }

                if (!contentBytes || contentBytes.get_size() === 0) {
                    this._log?.('[RawClipboard] Restore aborted: contentBytes is empty (0 bytes)');
                    return;
                }

                if (Meta?.SelectionSourceMemory?.new) {
                    try { source = Meta.SelectionSourceMemory.new(mime, contentBytes); } catch {}
                }

                if (source) {
                    source[RESTORE_NONCE] = nonce;
                    if (this._selection?.set_owner) this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
                    else St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mime, contentBytes);
                } else {
                    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mime, contentBytes);
                }

                // 仅当发布真正成功后，原子提交历史置顶与软删除解除
                if (this.#deletedEntries.has(entry)) {
                    this.#deletedEntries.delete(entry);
                    this._undoStack = this._undoStack.filter(e => e !== entry);
                    this._updateUndoButton();
                }

                const idx = this.#history.indexOf(entry);
                if (idx > 0) {
                    this.#history.splice(idx, 1);
                    this.#history.unshift(entry);
                }
            } finally {
                this._isRestoring = false;
            }
        } catch (e) {
            this._error('[RawClipboard] Restore failed:', e);
        }
    }

    _restoreEntry(entry) {
        if (!entry) return;
        const defaultMime = (entry.type === 'composite')
            ? (entry.formats?.[0]?.mime || entry.htmlMime || 'text/html')
            : (entry.formats?.[0]?.mime || entry.mime);
        this._restoreEntryFormat(entry, defaultMime);
    }

    _getAvailableConversions(entry) {
        if (!entry) return [];
        const isEn = this._getLanguage() === 'en-US';
        const conversions = [];
        if (entry.type !== 'text' && this._isTextPreviewable(entry)) {
            conversions.push({
                targetType: 'text',
                label: isEn ? 'Copy Text' : '复制文本',
                icon: ICON_TEXT,
            });
        }
        return conversions;
    }

    _convertEntry(entry, targetType) {
        if (!entry || targetType !== 'text') return;
        let textBytes = null;
        if (entry.type === 'composite') {
            textBytes = entry.textBytes;
            if (!textBytes || textBytes.get_size() === 0) {
                const htmlBytes = entry.htmlBytes;
                if (htmlBytes && htmlBytes.get_size() > 0) {
                    const plain = extractTextPreview(htmlBytes, true);
                    if (plain && plain.length > 0) {
                        textBytes = new GLib.Bytes(new TextEncoder().encode(plain));
                    }
                }
            }
        } else {
            textBytes = entry.bytes;
        }
        if (!textBytes || textBytes.get_size() === 0) return;

        const mime = 'text/plain;charset=utf-8';
        const copyTime = Date.now();
        const nonce = GLib.uuid_string_random();
        this.#activeNonces.add(nonce);
        this._addTimeout(500, () => {
            this.#activeNonces.delete(nonce);
            return GLib.SOURCE_REMOVE;
        });

        this._isRestoring = true;
        try {
            let source = null;
            if (Meta?.SelectionSourceMemory?.new) {
                try { source = Meta.SelectionSourceMemory.new(mime, textBytes); } catch {}
            }
            if (source) {
                source[RESTORE_NONCE] = nonce;
                if (this._selection?.set_owner) this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
                else St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mime, textBytes);
            } else {
                St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, mime, textBytes);
            }
        } finally {
            this._isRestoring = false;
        }

        const size = textBytes.get_size();
        const core = { type: 'text', mime, sourceMime: mime };
        const insertResult = this.#radixTree.insert(mime, textBytes, leaf => {
            return this._buildEntry(leaf, core, textBytes, size, copyTime);
        });

        if (insertResult.isDuplicate) {
            const existing = insertResult.existingEntry;
            try { existing.time = copyTime; } catch {}
            if (this.#deletedEntries.has(existing)) {
                this.#deletedEntries.delete(existing);
                this._undoStack = this._undoStack.filter(e => e !== existing);
                this._updateUndoButton();
            }
            const existingIdx = this.#history.indexOf(existing);
            if (existingIdx !== 0) {
                if (existingIdx > 0) this.#history.splice(existingIdx, 1);
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

    _deleteEntry(indexOrEntry) {
        if (!this._popup) {
            if (typeof indexOrEntry === 'number') {
                if (!Number.isInteger(indexOrEntry) || indexOrEntry < 0 || indexOrEntry >= this.#history.length) return;
                const [removed] = this.#history.splice(indexOrEntry, 1);
                if (removed) {
                    this._cancelThumbnailTask(removed);
                    this.#radixTree.remove(removed);
                }
            } else if (indexOrEntry && typeof indexOrEntry === 'object') {
                const idx = this.#history.indexOf(indexOrEntry);
                if (idx !== -1) {
                    this.#history.splice(idx, 1);
                    this._cancelThumbnailTask(indexOrEntry);
                    this.#radixTree.remove(indexOrEntry);
                }
            }
            return;
        }

        const sortedEntries = this._getSortedEntries();
        let entry = null;
        if (typeof indexOrEntry === 'number') {
            if (!Number.isInteger(indexOrEntry) || indexOrEntry < 0 || indexOrEntry >= sortedEntries.length) return;
            entry = sortedEntries[indexOrEntry];
        } else if (indexOrEntry && typeof indexOrEntry === 'object') {
            entry = indexOrEntry;
        }
        if (!entry || !this.#history.includes(entry) || this.#deletedEntries.has(entry)) return;

        this.#deletedEntries.add(entry);
        this._undoStack.push(entry);
        this._loopArmDirection = null;

        const remainingCount = sortedEntries.length - 1;
        const totalPages = Math.max(1, Math.ceil(remainingCount / 8));
        if (this._currentPage >= totalPages) this._currentPage = Math.max(0, totalPages - 1);

        const startIndex = this._currentPage * 8;
        const pageCount = Math.max(0, Math.min(8, remainingCount - startIndex));
        if (this._selectedIndex >= pageCount) this._selectedIndex = Math.max(0, pageCount - 1);

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

        const sortedEntries = this._getSortedEntries();
        const sortedIndex = sortedEntries.indexOf(entry);
        if (sortedIndex !== -1) {
            this._currentPage = Math.floor(sortedIndex / 8);
            this._selectedIndex = sortedIndex % 8;
        }

        this._renderPage();
        this._updatePageBadge();
        this._updateUndoButton();
        return true;
    }

    _commitPendingDeletions() {
        if (this.#deletedEntries.size > 0) {
            this.#history = this.#history.filter(entry => {
                if (this.#deletedEntries.has(entry)) {
                    this._cancelThumbnailTask(entry);
                    this.#radixTree.remove(entry);
                    return false;
                }
                return true;
            });
            this.#deletedEntries.clear();
            this._undoStack = [];
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
        const popupWidth = 420;
        const maxDisplayCount = 8;
        const itemHeight = 48;
        const itemSpacing = 2;
        const popupPaddingY = 12;
        const popupBorderY = 2;
        const sortBarHeight = 34;
        const pageBarHeight = 28;

        let contentHeight = maxDisplayCount * itemHeight + (maxDisplayCount - 1) * itemSpacing;
        let popupHeight = sortBarHeight + contentHeight + popupPaddingY + popupBorderY + pageBarHeight;

        const maxMonitorHeight = monitor ? (monitor.height - 64) : 800;
        if (popupHeight > maxMonitorHeight) {
            popupHeight = maxMonitorHeight;
            contentHeight = Math.max(50, popupHeight - popupPaddingY - popupBorderY - sortBarHeight - pageBarHeight);
        }

        return { popupWidth, popupHeight, contentHeight, sortBarHeight, pageBarHeight };
    }

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
            this._pageBadge.text = `${isEn ? 'Loop? ' : '循环？ '}${this._currentPage + 1} / ${totalPages}`;
            this._pageBadge.show();
        } else {
            this._pageBadge.text = `${this._currentPage + 1} / ${totalPages}`;
            this._pageBadge.show();
        }
    }

    _togglePopup() {
        if (this._container && !this._isClosing) this._closePopup();
        else if (!this._container) this._openPopup();
    }

    _openPopup() {
        if (this._container || this._isClosing) return;

        this.#deletedEntries.clear();
        this._undoStack = [];
        this._inSearchMode = false;
        this._searchQuery = '';
        this._loopArmDirection = null;

        try {
            const [mouseX, mouseY] = global.get_pointer();
            let monitor = Main.layoutManager.primaryMonitor;
            const monitors = Main.layoutManager.monitors || [];
            for (const m of monitors) {
                if (mouseX >= m.x && mouseX < m.x + m.width && mouseY >= m.y && mouseY < m.y + m.height) {
                    monitor = m;
                    break;
                }
            }
            if (!monitor) monitor = { x: 0, y: 0, width: global.stage.width, height: global.stage.height };

            this._container = new Clutter.Actor({
                name: 'rawClipboardModalContainer',
                reactive: true,
                x: 0, y: 0,
                width: global.stage.width,
                height: global.stage.height,
            });

            this._popup = new St.BoxLayout({
                name: 'rawClipboardPopup',
                style_class: 'popup-menu-content raw-clipboard-popup',
                orientation: Clutter.Orientation.VERTICAL,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            this._popup.connect('button-press-event', () => {
                if (this._contextMenu) { this._closeContextMenu(); return Clutter.EVENT_STOP; }
                if (this._inSearchMode) this._exitSearchMode();
                return Clutter.EVENT_STOP;
            });

            const { popupWidth, popupHeight, contentHeight, pageBarHeight, sortBarHeight } = this._calculateDesiredDimensions(monitor);
            const contentWidth = popupWidth - 12;

            // 顶部排序栏
            this._sortBar = new St.BoxLayout({
                style_class: 'raw-clipboard-sort-bar',
                orientation: Clutter.Orientation.HORIZONTAL,
                reactive: true,
                x_expand: true,
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
                if (btnLabel.clutter_text) btnLabel.clutter_text.use_markup = false;
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
                    if (this._contextMenu) this._closeContextMenu();
                    if (event.get_button() === 1) {
                        this._setSortMode(opt.id);
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                btn.connect('button-release-event', () => Clutter.EVENT_STOP);
                btn.connect('clicked', () => {
                    if (this._contextMenu) this._closeContextMenu();
                    this._setSortMode(opt.id);
                });
                this._sortButtons.set(opt.id, btn);
                this._sortBar.add_child(btn);
            });
            this._popup.add_child(this._sortBar);

            // 搜索栏
            this._searchBar = new St.BoxLayout({
                style_class: 'raw-clipboard-search-bar',
                orientation: Clutter.Orientation.HORIZONTAL,
                reactive: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            this._searchBar.connect('button-press-event', () => {
                if (this._contextMenu) { this._closeContextMenu(); return Clutter.EVENT_STOP; }
                if (this._inSearchMode) this._exitSearchMode();
                return Clutter.EVENT_STOP;
            });

            const searchIcon = new St.Icon({
                icon_name: 'system-search-symbolic',
                icon_size: 14,
                style_class: 'raw-clipboard-search-icon',
                y_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });
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

            // 列表容器
            this._listContainer = new St.BoxLayout({
                style_class: 'raw-clipboard-list',
                orientation: Clutter.Orientation.VERTICAL,
                reactive: true,
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.START,
            });
            this._listContainer.connect('button-press-event', () => {
                if (this._contextMenu) { this._closeContextMenu(); return Clutter.EVENT_STOP; }
                if (this._inSearchMode) this._exitSearchMode();
                return Clutter.EVENT_STOP;
            });
            this._popup.add_child(this._listContainer);

            // 底部操作与页码栏
            this._pageBar = new St.BoxLayout({
                style_class: 'raw-clipboard-page-bar',
                orientation: Clutter.Orientation.HORIZONTAL,
                reactive: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._pageBar.connect('button-press-event', () => {
                if (this._contextMenu) { this._closeContextMenu(); return Clutter.EVENT_STOP; }
                if (this._inSearchMode) this._exitSearchMode();
                return Clutter.EVENT_STOP;
            });

            const undoIcon = new St.Icon({ icon_name: 'edit-undo-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER });
            const undoLabel = new St.Label({ text: isEn ? 'Undo' : '撤销', style_class: 'raw-clipboard-undo-label', y_align: Clutter.ActorAlign.CENTER });
            if (undoLabel.clutter_text) undoLabel.clutter_text.use_markup = false;
            this._undoLabel = undoLabel;

            const undoBox = new St.BoxLayout({ style_class: 'raw-clipboard-undo-box', orientation: Clutter.Orientation.HORIZONTAL, y_align: Clutter.ActorAlign.CENTER });
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
                if (this._contextMenu) this._closeContextMenu();
                this._undoLastDelete();
            });
            this._undoBtn.connect('button-press-event', (_actor, event) => {
                if (this._contextMenu) this._closeContextMenu();
                if (event.get_button() === 1 && this._undoBtn.reactive) {
                    this._undoLastDelete();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._pageBar.add_child(this._undoBtn);

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

            this._container.add_child(this._popup);
            Main.layoutManager.uiGroup.add_child(this._container);

            this._popup.set_size(popupWidth, popupHeight);
            this._popup.width = popupWidth;
            this._popup.height = popupHeight;
            this._popup.min_height = popupHeight;
            this._popup.max_height = popupHeight;

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

            this._listContainer.set_size(contentWidth, contentHeight);
            this._listContainer.width = contentWidth;
            this._listContainer.height = contentHeight;
            this._listContainer.min_height = contentHeight;
            this._listContainer.max_height = contentHeight;

            this._pageBar.set_size(contentWidth, pageBarHeight);
            this._pageBar.width = contentWidth;
            this._pageBar.height = pageBarHeight;
            this._pageBar.min_height = pageBarHeight;
            this._pageBar.max_height = pageBarHeight;

            let posX = mouseX + 8, posY = mouseY + 8;
            if (posX + popupWidth > monitor.x + monitor.width - 8) posX = mouseX - popupWidth - 8;
            if (posY + popupHeight > monitor.y + monitor.height - 8) posY = mouseY - popupHeight - 8;
            posX = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - popupWidth - 8, posX));
            posY = Math.max(monitor.y + 8, Math.min(monitor.y + monitor.height - popupHeight - 8, posY));
            this._popup.set_position(posX, posY);

            // 触控板与鼠标滚轮事件处理
            let lastScrollTime = 0, lastScrollDir = 0, smoothAccumulator = 0, smoothGestureLocked = false, lastSmoothTime = 0, lastGestureDir = 0;
            const SMOOTH_THRESHOLD = 0.35, SMOOTH_TIMEOUT_MS = 180, WHEEL_DEBOUNCE_MS = 60;

            const handleScrollEvent = (_actor, event) => {
                if (this._contextMenu) this._closeContextMenu();
                const currentEntries = this._getSortedEntries();
                const totalPages = Math.max(1, Math.ceil(currentEntries.length / 8));
                if (totalPages <= 1) return Clutter.EVENT_STOP;

                const now = Date.now();
                const direction = event.get_scroll_direction();
                let delta = 0;

                const finishFlags = typeof event.get_scroll_finish_flags === 'function' ? event.get_scroll_finish_flags() : 0;
                if (finishFlags && (finishFlags & Clutter.ScrollFinishFlags.VERTICAL)) {
                    smoothGestureLocked = false;
                    smoothAccumulator = 0;
                    lastSmoothTime = 0;
                    lastGestureDir = 0;
                }

                if (direction === Clutter.ScrollDirection.UP) {
                    delta = -1;
                    smoothGestureLocked = false;
                    smoothAccumulator = 0;
                    lastGestureDir = 0;
                } else if (direction === Clutter.ScrollDirection.DOWN) {
                    delta = 1;
                    smoothGestureLocked = false;
                    smoothAccumulator = 0;
                    lastGestureDir = 0;
                } else if (direction === Clutter.ScrollDirection.SMOOTH) {
                    const [, dy] = event.get_scroll_delta();
                    if (now - lastSmoothTime > SMOOTH_TIMEOUT_MS) {
                        smoothGestureLocked = false;
                        smoothAccumulator = 0;
                        lastGestureDir = 0;
                    }
                    lastSmoothTime = now;

                    const currentSign = dy > 0.05 ? 1 : (dy < -0.05 ? -1 : 0);
                    if (currentSign !== 0) {
                        if (lastScrollDir !== 0 && currentSign !== lastScrollDir) {
                            smoothGestureLocked = false;
                            lastScrollDir = 0;
                        }
                        if (lastGestureDir !== 0 && currentSign !== lastGestureDir) {
                            smoothAccumulator = 0;
                        }
                        lastGestureDir = currentSign;
                    }

                    if (smoothGestureLocked) return Clutter.EVENT_STOP;

                    smoothAccumulator += dy;
                    if (smoothAccumulator >= SMOOTH_THRESHOLD) {
                        delta = 1;
                        smoothAccumulator = 0;
                        smoothGestureLocked = true;
                        lastGestureDir = 0;
                    } else if (smoothAccumulator <= -SMOOTH_THRESHOLD) {
                        delta = -1;
                        smoothAccumulator = 0;
                        smoothGestureLocked = true;
                        lastGestureDir = 0;
                    } else {
                        return Clutter.EVENT_STOP;
                    }
                }

                if (delta !== 0) {
                    if (direction !== Clutter.ScrollDirection.SMOOTH) {
                        const isReversal = (lastScrollDir !== 0 && delta !== lastScrollDir);
                        if (!isReversal && (now - lastScrollTime < WHEEL_DEBOUNCE_MS)) return Clutter.EVENT_STOP;
                    }

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

            this._currentPage = 0;
            this._selectedIndex = 0;
            this._renderPage();
            this._updatePageBadge();
            this._updateUndoButton();

            this._container.connect('button-press-event', () => {
                if (this._contextMenu) { this._closeContextMenu(); return Clutter.EVENT_STOP; }
                if (this._inSearchMode) { this._exitSearchMode(); return Clutter.EVENT_STOP; }
                this._closePopup();
                return Clutter.EVENT_STOP;
            });

            this._container.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

            this._grab = Main.pushModal(this._container, { actionMode: Shell.ActionMode.POPUP });
            if (!this._grab && this._grab !== 0) {
                this._closePopup();
                return;
            }

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

        const createMenuItem = (iconName, labelText, onActivate) => {
            const box = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
            const { gicon, iconName: resolvedName } = this._resolveIcon(iconName);
            const icon = new St.Icon({
                style_class: 'raw-clipboard-menu-item-icon',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                ...(gicon ? { gicon } : { icon_name: resolvedName }),
            });
            icon._resolvedIconName = resolvedName;
            const label = new St.Label({ text: labelText, style_class: 'raw-clipboard-menu-item-label', y_align: Clutter.ActorAlign.CENTER });
            if (label.clutter_text) label.clutter_text.use_markup = false;
            box.add_child(icon);
            box.add_child(label);
            const btn = new St.Button({ style_class: 'raw-clipboard-menu-item', can_focus: true, reactive: true, track_hover: true, child: box, x_expand: true });
            let handled = false;
            const trigger = () => { if (!handled) { handled = true; onActivate(); } };
            btn.connect('clicked', trigger);
            btn.connect('button-press-event', (_a, ev) => { if (ev.get_button() === 1) { trigger(); return Clutter.EVENT_STOP; } return Clutter.EVENT_STOP; });
            return btn;
        };

        // 1. 带入搜索
        const searchBtn = createMenuItem('system-search-symbolic', isEn ? 'Search Preview' : '带入搜索', () => {
            let preview = this._getEntryPreview(entry);
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                const segs = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(preview));
                if (segs.length > MAX_SEARCH_IMPORT_LEN) preview = segs.slice(0, MAX_SEARCH_IMPORT_LEN).map(s => s.segment).join('');
            } else {
                preview = Array.from(preview).slice(0, MAX_SEARCH_IMPORT_LEN).join('');
            }
            this._closeContextMenu();
            this._enterSearchMode(preview);
        });
        menu.add_child(searchBtn);

        // 2. 格式转换 (复制文本)
        const conversions = this._getAvailableConversions(entry);
        for (const conv of conversions) {
            const convBtn = createMenuItem(conv.icon || ICON_TEXT, conv.label, () => {
                this._convertEntry(entry, conv.targetType);
            });
            menu.add_child(convBtn);
        }

        this._contextMenu = menu;
        this._container.add_child(menu);

        let posX = (typeof x === 'number' && !isNaN(x)) ? x : 0;
        let posY = (typeof y === 'number' && !isNaN(y)) ? y : 0;
        let monitor = null;
        const monitors = Main.layoutManager.monitors || [];
        for (const m of monitors) {
            if (posX >= m.x && posX < m.x + m.width && posY >= m.y && posY < m.y + m.height) { monitor = m; break; }
        }
        if (!monitor && this._container) {
            const [cX, cY] = this._container.get_position ? this._container.get_position() : [this._container.x || 0, this._container.y || 0];
            for (const m of monitors) {
                if (cX >= m.x && cX < m.x + m.width && cY >= m.y && cY < m.y + m.height) { monitor = m; break; }
            }
        }
        if (!monitor) monitor = Main.layoutManager.primaryMonitor || { x: 0, y: 0, width: global.stage.width, height: global.stage.height };

        const menuWidth = 140;
        const menuHeight = (conversions.length > 0) ? (38 + conversions.length * 34) : 38;
        if (posX + menuWidth > monitor.x + monitor.width - 8) posX = posX - menuWidth;
        if (posY + menuHeight > monitor.y + monitor.height - 8) posY = posY - menuHeight;
        posX = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - menuWidth - 8, posX));
        posY = Math.max(monitor.y + 8, Math.min(monitor.y + monitor.height - menuHeight - 8, posY));
        menu.set_position(posX, posY);
    }

    _closeContextMenu() {
        if (!this._contextMenu) return;
        try {
            const parent = this._contextMenu.get_parent ? this._contextMenu.get_parent() : this._contextMenu.parent;
            if (parent?.remove_child) parent.remove_child(this._contextMenu);
            if (this._contextMenu.destroy) this._contextMenu.destroy();
        } catch {}
        this._contextMenu = null;
    }

    _destroyPopupUI() {
        this._closeContextMenu();
        if (this._grab) {
            try { Main.popModal(this._grab); } catch {}
            this._grab = null;
        }
        if (this._renderIdleId) {
            try { GLib.source_remove(this._renderIdleId); } catch {}
            this._renderIdleId = 0;
        }

        if (this._itemSlots) {
            for (const slot of this._itemSlots) {
                if (slot) {
                    slot.currentEntry = null;
                    if (slot.typeBtn0) {
                        slot.typeBtn0._targetMime = null;
                        slot.typeBtn0._currentGIcon = null;
                        slot.typeBtn0._currentIconName = null;
                    }
                    if (slot.typeBtn1) {
                        slot.typeBtn1._targetMime = null;
                        slot.typeBtn1._currentGIcon = null;
                        slot.typeBtn1._currentIconName = null;
                    }
                    try { slot.itemBox.destroy(); } catch {}
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
                if (parent?.remove_child) parent.remove_child(this._container);
                else Main.layoutManager.uiGroup.remove_child(this._container);
            } catch {}
            try { this._container.destroy(); } catch {}
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
        this._commitPendingDeletions();

        if (this._grab) {
            try { Main.popModal(this._grab); } catch {}
            this._grab = null;
        }
        this._container.reactive = false;

        const animDuration = shouldUseMotion() ? 100 : 0;
        const cleanup = () => this._destroyPopupUI();

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
        if (typeof itemBox.set_height === 'function') itemBox.set_height(48);
        itemBox.height = 48;
        itemBox.min_height = 48;
        itemBox.max_height = 48;

        const iconBox = new St.BoxLayout({
            style_class: 'raw-clipboard-type-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            reactive: true,
        });

        const handleTypeClick = (btn) => {
            if (this._contextMenu) this._closeContextMenu();
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
            btn._currentGIcon = null;
            btn._currentIconName = null;

            btn.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 1) {
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

        // 兼容测试反射属性
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

        const contentBox = new St.BoxLayout({
            style_class: 'raw-clipboard-item-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const previewLabel = new St.Label({ text: '', style_class: 'raw-clipboard-item-preview' });
        if (previewLabel.clutter_text) {
            previewLabel.clutter_text.use_markup = false;
            previewLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        const subLabel = new St.Label({ text: '', style_class: 'raw-clipboard-item-sub' });
        if (subLabel.clutter_text) {
            subLabel.clutter_text.use_markup = false;
            subLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        contentBox.add_child(previewLabel);
        contentBox.add_child(subLabel);
        itemBox.add_child(contentBox);

        const timeLabel = new St.Label({ text: '', style_class: 'raw-clipboard-item-time', y_align: Clutter.ActorAlign.CENTER });
        if (timeLabel.clutter_text) timeLabel.clutter_text.use_markup = false;
        itemBox.add_child(timeLabel);

        const deleteIcon = new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
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
        };

        const triggerDelete = () => {
            if (this._contextMenu) this._closeContextMenu();
            if (slot.currentEntry) this._deleteEntry(slot.currentEntry);
        };
        deleteBtn.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 1) { triggerDelete(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
        deleteBtn.connect('button-release-event', () => Clutter.EVENT_STOP);
        deleteBtn.connect('clicked', triggerDelete);
        itemBox.add_child(deleteBtn);

        itemBox.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === 1 && slot.currentEntry) {
                if (this._contextMenu) { this._closeContextMenu(); return Clutter.EVENT_STOP; }
                try {
                    this._restoreEntry(slot.currentEntry);
                    this._closePopup();
                } catch (e) {
                    this._error('[RawClipboard] Restore on click failed:', e);
                }
                return Clutter.EVENT_STOP;
            } else if (button === 3 && slot.currentEntry) {
                this._setSelectedIndex(slotIndex);
                let coords = typeof event.get_coords === 'function' ? event.get_coords() : null;
                if (!coords || !Array.isArray(coords)) coords = global.get_pointer ? global.get_pointer() : [0, 0];
                this._openContextMenu(slot.currentEntry, coords[0], coords[1]);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        itemBox.connect('notify::hover', () => {
            if (itemBox.hover) this._setSelectedIndex(slotIndex);
        });

        return slot;
    }

    _resolveIcon(name) {
        const defaultName = name || ICON_RAW;
        if (this.#iconCache.has(defaultName)) return this.#iconCache.get(defaultName);
        let res = { gicon: null, iconName: defaultName };
        if (this.path) {
            const localSvg = GLib.build_filenamev([this.path, 'icons', `${defaultName}.svg`]);
            if (GLib.file_test(localSvg, GLib.FileTest.EXISTS)) {
                try {
                    res = { gicon: Gio.icon_new_for_string(localSvg), iconName: defaultName };
                } catch {}
            }
        }
        this.#iconCache.set(defaultName, res);
        return res;
    }

    _applyButtonIcon(btn, name, iconSize = 20) {
        const { gicon, iconName } = this._resolveIcon(name);
        if (btn._currentIconName === iconName && btn._currentGIcon === gicon) return;
        btn._icon._resolvedIconName = iconName;
        if (gicon) {
            btn._icon.icon_name = null;
            btn._icon.gicon = gicon;
        } else {
            btn._icon.gicon = null;
            btn._icon.icon_name = iconName;
        }
        btn._icon.style_class = 'raw-clipboard-item-icon';
        btn._icon.icon_size = iconSize;
        btn._currentIconName = iconName;
        btn._currentGIcon = gicon;
    }

    _applySlotIcon(slot) {
        const entry = slot.currentEntry;
        if (!entry) return;

        const formats = (entry.formats && entry.formats.length > 0) ? entry.formats : [{
            mime: entry.mime,
            type: entry.type,
            icon: entry.icon || ICON_RAW,
        }];

        const fmt0 = formats[0];
        slot.typeBtn0._targetMime = fmt0.mime;
        const thumb = entry.thumbIcon;
        if (thumb) {
            if (slot.typeBtn0._currentGIcon !== thumb) {
                slot.typeBtn0._icon.icon_name = null;
                slot.typeBtn0._icon.gicon = thumb;
                slot.typeBtn0._icon._resolvedIconName = null;
                slot.typeBtn0._icon.style_class = 'raw-clipboard-item-thumb';
                slot.typeBtn0._icon.icon_size = 34;
                slot.typeBtn0._currentGIcon = thumb;
                slot.typeBtn0._currentIconName = null;
            }
        } else {
            this._applyButtonIcon(slot.typeBtn0, fmt0.icon || entry.icon, 20);
        }
        slot.typeBtn0.show();

        if (formats.length > 1) {
            const fmt1 = formats[1];
            slot.typeBtn1._targetMime = fmt1.mime;
            this._applyButtonIcon(slot.typeBtn1, fmt1.icon, 20);
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
        if (!this._itemSlots) this._itemSlots = [];

        const sortedEntries = this._getSortedEntries();
        const totalCount = sortedEntries.length;

        if (totalCount === 0) {
            this._currentPage = 0;
            this._selectedIndex = 0;
            this._itemActors = [];
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
                if (this._emptyLabel.clutter_text) this._emptyLabel.clutter_text.use_markup = false;
                this._emptyLabel.connect('button-press-event', () => {
                    if (this._inSearchMode) this._exitSearchMode();
                    return Clutter.EVENT_STOP;
                });
                this._listContainer.add_child(this._emptyLabel);
            }
            this._emptyLabel.text = this._getEmptyText();
            this._emptyLabel.show();
            return;
        }

        if (this._emptyLabel) this._emptyLabel.hide();

        const totalPages = Math.max(1, Math.ceil(totalCount / 8));
        if (this._currentPage >= totalPages) this._currentPage = Math.max(0, totalPages - 1);
        const startIndex = this._currentPage * 8;
        const pageItems = sortedEntries.slice(startIndex, startIndex + 8);
        if (this._selectedIndex >= pageItems.length) this._selectedIndex = Math.max(0, pageItems.length - 1);

        for (let i = 0; i < pageItems.length; i++) {
            const entry = pageItems[i];
            let slot = this._itemSlots[i];
            if (!slot) {
                slot = this._createSlot(i);
                this._itemSlots[i] = slot;
                this._listContainer.add_child(slot.itemBox);
            }

            slot.currentEntry = entry;
            this._applySlotIcon(slot);

            const previewText = this._getEntryPreview(entry);
            if (slot.previewLabel.text !== previewText) slot.previewLabel.text = previewText;

            const subtitleText = this._getEntrySubtitle(entry);
            if (slot.subLabel.text !== subtitleText) slot.subLabel.text = subtitleText;

            const timeText = this._formatTime(entry.time);
            if (slot.timeLabel.text !== timeText) slot.timeLabel.text = timeText;

            if (i === this._selectedIndex) slot.itemBox.add_style_class_name('selected');
            else slot.itemBox.remove_style_class_name('selected');

            slot.itemBox.show();
        }

        for (let i = pageItems.length; i < this._itemSlots.length; i++) {
            this._itemSlots[i].currentEntry = null;
            this._itemSlots[i].itemBox.hide();
        }

        this._itemActors = this._itemSlots.slice(0, pageItems.length).map(s => s.itemBox);
    }

    _getSelectedEntry() {
        if (this._itemSlots && this._selectedIndex >= 0 && this._selectedIndex < this._itemSlots.length) {
            const slot = this._itemSlots[this._selectedIndex];
            if (slot && slot.currentEntry) return slot.currentEntry;
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
                if (i === this._selectedIndex) actor.add_style_class_name('selected');
                else actor.remove_style_class_name('selected');
            });
        }
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            if (this._contextMenu) { this._closeContextMenu(); return Clutter.EVENT_STOP; }
            if (this._inSearchMode) { this._exitSearchMode(); return Clutter.EVENT_STOP; }
            this._closePopup();
            return Clutter.EVENT_STOP;
        }

        if (this._contextMenu) this._closeContextMenu();

        const state = typeof event.get_state === 'function' ? event.get_state() : 0;
        const SORT_MODES = ['queue', 'size', 'type', 'initial'];
        const isShift = Boolean(state & Clutter.ModifierType.SHIFT_MASK);

        // Tab / Shift+Tab: 切换排序方式
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

        // 快捷键退出兜底
        if (this._settings) {
            const shortcuts = this._settings.get_strv('toggle-shortcut');
            if (shortcuts && shortcuts.length > 0) {
                const relevantMods = state & (
                    Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
                    Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.SUPER_MASK
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

        // Ctrl+Z: 撤销
        if (isCtrl && (symbol === Clutter.KEY_z || symbol === Clutter.KEY_Z)) {
            if (!this._inSearchMode && this._undoLastDelete()) return Clutter.EVENT_STOP;
        }

        // BackSpace
        if (symbol === Clutter.KEY_BackSpace) {
            if (this._inSearchMode) {
                if (this._searchQuery.length > 0) {
                    this._loopArmDirection = null;
                    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                        const segs = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(this._searchQuery));
                        this._searchQuery = segs.length > 0 ? segs.slice(0, -1).map(s => s.segment).join('') : '';
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
                const target = this._getSelectedEntry();
                if (target) this._deleteEntry(target);
                return Clutter.EVENT_STOP;
            }
        }

        // Delete
        if (symbol === Clutter.KEY_Delete) {
            if (!this._inSearchMode) {
                const target = this._getSelectedEntry();
                if (target) this._deleteEntry(target);
            }
            return Clutter.EVENT_STOP;
        }

        // Enter / KP_Enter / Space
        const isConfirmKey = symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || (!this._inSearchMode && symbol === Clutter.KEY_space);
        if (isConfirmKey) {
            const target = this._getSelectedEntry();
            if (target) this._restoreEntry(target);
            this._closePopup();
            return Clutter.EVENT_STOP;
        }

        // 列表方向键导航
        const currentEntries = this._getSortedEntries();
        const totalCount = currentEntries.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / 8));
        const startIndex = this._currentPage * 8;
        const pageCount = (this._itemActors && this._itemActors.length > 0)
            ? this._itemActors.length
            : Math.max(0, Math.min(8, totalCount - startIndex));

        // Up
        if (symbol === Clutter.KEY_Up) {
            if (totalCount > 0) {
                if (this._selectedIndex > 0) {
                    this._clearLoopArm();
                    this._setSelectedIndex(this._selectedIndex - 1);
                } else if (this._currentPage > 0) {
                    this._clearLoopArm();
                    this._setPage(this._currentPage - 1, 7);
                } else if (totalPages > 1) {
                    if (this._loopArmDirection !== 'up') {
                        this._loopArmDirection = 'up';
                        this._updatePageBadge();
                        return Clutter.EVENT_STOP;
                    }
                    this._loopArmDirection = null;
                    const lastPage = totalPages - 1;
                    const lastCount = totalCount - lastPage * 8;
                    this._setPage(lastPage, lastCount - 1);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // Down
        if (symbol === Clutter.KEY_Down) {
            if (totalCount > 0) {
                if (this._selectedIndex < pageCount - 1) {
                    this._clearLoopArm();
                    this._setSelectedIndex(this._selectedIndex + 1);
                } else if (this._currentPage < totalPages - 1) {
                    this._clearLoopArm();
                    this._setPage(this._currentPage + 1, 0);
                } else if (totalPages > 1) {
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

        // Left / PageUp
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
                this._setPage((this._currentPage - 1 + totalPages) % totalPages, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // Right / PageDown
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
                this._setPage((this._currentPage + 1) % totalPages, this._selectedIndex);
            }
            return Clutter.EVENT_STOP;
        }

        // 字符输入
        const char = getPrintableChar(event);
        if (char) {
            if (!this._inSearchMode) {
                this._enterSearchMode(char);
                return Clutter.EVENT_STOP;
            } else {
                if (this._searchQuery.length + char.length <= MAX_SEARCH_QUERY_LEN) {
                    this._loopArmDirection = null;
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
