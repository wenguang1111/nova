import { editorMessages } from './locales/editor.js';
import { runtimeMessages } from './locales/runtime.js';
import { remoteMessages } from './locales/remote.js';
import { germanMessages } from './locales/de.js';

const messages = {
    ...editorMessages,
    ...runtimeMessages,
    ...remoteMessages,
    'Nova Drill Control': 'Nova 球路控制',
    'Language': '语言',
    'Show/Hide Log': '显示/隐藏日志',
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
    'Random': '随机顺序',
    'Delete': '删除',
    'Test drill': '测试球路',
    'Save As': '另存为',
    'Share': '共享',
    'Share Your Drill': '共享你的球路',
    'Your Name (Max 30)': '你的名字（最多 30 字符）',
    'Short Description (Max 100)': '球路简短描述（最多 100 字符）',
    'Enter your name': '请输入你的名字',
    'Enter a description': '请输入球路描述',
    'Shared. Thank you!': '已共享，谢谢！',
    'Sharing is not configured': '共享功能尚未配置',
    'Save': '保存',
    'STOP': '停止',
    'Import Drill': '导入球路',
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
    'Bank {category} is full!': '分组 {category} 已满！',
    'Download Error': '下载失败',
    'Password': '密码',
    'Load List': '加载列表',
    'Select drills to import': '勾选要导入的球路',
    'Wrong password': '密码错误',
    'Too many attempts, try again later': '尝试次数过多，请稍后再试',
    'No shared drills yet': '暂时没有共享的球路',
    'Enter the password': '请输入密码',
    'Loading...': '加载中…',
    'Select at least one drill': '请至少勾选一个球路',
    'Select up to {count} drills': '最多一次勾选 {count} 个球路',
    'Imported {count} to {category}': '已导入 {count} 个球路到分组 {category}',
    'Imported {count} to {category}, skipped {skipped}': '已导入 {count} 个球路到分组 {category}，跳过 {skipped} 个'
};

const supportedLanguages = ['zh-CN', 'en', 'de'];
const catalogs = { 'zh-CN': messages, de: germanMessages };
const preferenceKey = 'nova_language';
let language = 'en';

export function t(key, values = {}) {
    const message = catalogs[language]?.[key] ?? key;
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

// First device language (in the user's preference order) that we have a catalog for.
function deviceLanguage() {
    for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language || 'en']) {
        const lower = tag.toLowerCase();
        if (lower.startsWith('zh')) return 'zh-CN';
        if (lower.startsWith('de')) return 'de';
        if (lower.startsWith('en')) return 'en';
    }
    return 'en';
}

export function initLanguage() {
    const saved = localStorage.getItem(preferenceKey);
    language = supportedLanguages.includes(saved) ? saved : deviceLanguage();
    translatePage();
    document.getElementById('language-select').addEventListener('change', event => {
        const nextLanguage = event.target.value;
        if (!supportedLanguages.includes(nextLanguage)) return;
        language = nextLanguage;
        localStorage.setItem(preferenceKey, language);
        translatePage();
    });
}
