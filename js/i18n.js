import { editorMessages } from './locales/editor.js';
import { runtimeMessages } from './locales/runtime.js';

const messages = {
    ...editorMessages,
    ...runtimeMessages,
    'Nova Drill Control': 'Nova 球路控制',
    'Language': '语言',
    'Drill': '球路',
    'Download Drill': '下载球路',
    'Export Drills': '导出球路',
    'Import Drills': '导入球路',
    'Theme': '主题',
    'Standard': '标准',
    'Ocean': '海洋',
    'Forest': '森林',
    'Dark': '深色',
    'Reset Statistics': '重置统计',
    'Factory Reset': '恢复出厂设置',
    'About': '关于',
    'DIFFICULTY LEVEL': '难度等级',
    'Reps': '次数',
    'Time': '时间',
    'Count': '次数',
    'Time (s)': '时间（秒）',
    'Pause (s)': '间隔（秒）',
    'Drill Selection': '选择球路',
    'Basic': '基础',
    'Combined': '组合',
    'Complex': '复杂',
    'Custom A': '自定义 A',
    'Custom B': '自定义 B',
    'Custom C': '自定义 C',
    'Share Drill': '分享球路',
    'Random': '随机顺序',
    'Delete': '删除',
    'Test drill': '测试球路',
    'Save As': '另存为',
    'Save': '保存',
    'STOP': '停止',
    'Import Drill': '导入球路',
    'Share Code': '分享码',
    'Select Destination': '选择目标分组',
    'Download & Import': '下载并导入',
    'Save As New Drill': '另存为新球路',
    'Drill Name (Max 40)': '球路名称（最多 40 字符）',
    'My New Drill': '我的新球路',
    'Save Drill': '保存球路',
    'View on GitHub': '查看 GitHub 仓库',
    'Session Summary': '本次训练统计',
    'Training session complete!': '本次训练已完成！',
    'Drills': '球路',
    'Balls': '球数',
    'Close': '关闭',
    'Device not connected': '设备未连接',
    'Invalid code (Must be 6 chars)': '分享码无效（必须为 6 个字符）',
    'Bank {category} is full!': '分组 {category} 已满！',
    'Searching...': '正在查找…',
    'Code not found': '未找到分享码',
    'Imported to {category}': '已导入分组 {category}',
    'Download Error': '下载失败'
};

const supportedLanguages = ['zh-CN', 'en'];
const preferenceKey = 'nova_language';
let language = 'en';

export function t(key, values = {}) {
    const message = language === 'zh-CN' ? (messages[key] ?? key) : key;
    return message.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : match);
}

function translatePage() {
    document.documentElement.lang = language;
    document.querySelectorAll('[data-i18n]').forEach(element => {
        element.textContent = t(element.dataset.i18n);
    });
    for (const attribute of ['title', 'placeholder']) {
        document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
            element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
        });
    }
    document.getElementById('language-select').value = language;
    document.dispatchEvent(new CustomEvent('language-changed'));
}

export function initLanguage() {
    const saved = localStorage.getItem(preferenceKey);
    const preferred = navigator.languages?.[0] || navigator.language || 'en';
    language = supportedLanguages.includes(saved) ? saved :
        (preferred.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');
    translatePage();
    document.getElementById('language-select').addEventListener('change', event => {
        const nextLanguage = event.target.value;
        if (!supportedLanguages.includes(nextLanguage)) return;
        language = nextLanguage;
        localStorage.setItem(preferenceKey, language);
        translatePage();
    });
}
