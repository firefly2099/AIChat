// Markdown 渲染：基于 markdown-it + highlight.js + DOMPurify，输出 XSS 安全 HTML。
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
// 引入亮色代码主题，配合浅色气泡背景
import 'highlight.js/styles/github.css'

/**
 * Markdown 渲染器：支持代码高亮、链接、表格、列表等。
 * - html 关闭，避免 AI 返回的原始 HTML 注入；
 * - breaks 开启，换行转 <br>，更贴合聊天场景；
 * - linkify 开启，自动识别裸链接。
 */
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
})

/**
 * 覆盖围栏代码块渲染，确保 code 上带有 hljs class，便于主题样式命中。
 * 优先按指定语言高亮，失败时自动检测，再失败则转义原文。
 */
md.renderer.rules.fence = function (tokens, idx) {
  const token = tokens[idx]
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
  const langName = info ? info.split(/\s+/g)[0] : ''
  const code = token.content

  let highlighted: string
  if (langName && hljs.getLanguage(langName)) {
    try {
      highlighted = hljs.highlight(code, { language: langName }).value
    } catch {
      highlighted = md.utils.escapeHtml(code)
    }
  } else {
    try {
      highlighted = hljs.highlightAuto(code).value
    } catch {
      highlighted = md.utils.escapeHtml(code)
    }
  }

  const cls = langName ? ` class="hljs language-${langName}"` : ' class="hljs"'
  return `<pre><code${cls}>${highlighted}</code></pre>\n`
}

// 行内代码也加上 hljs class，保持样式一致
md.renderer.rules.code_inline = function (tokens, idx) {
  const token = tokens[idx]
  return `<code class="hljs inline">${md.utils.escapeHtml(token.content)}</code>`
}

/**
 * 链接统一在新标签打开，并补充 rel 安全属性，避免在应用内跳转。
 */
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]
  if (!token) {
    return defaultLinkOpen(tokens, idx, options, env, self)
  }

  // 统一设置 target/rel：attrIndex 命中时 attrs 必然存在，仍做一次守卫以通过严格类型检查
  const setAttr = (name: string, value: string) => {
    const attrIndex = token.attrIndex(name)
    if (attrIndex < 0) {
      token.attrPush([name, value])
    } else if (token.attrs) {
      token.attrs[attrIndex][1] = value
    }
  }

  setAttr('target', '_blank')
  setAttr('rel', 'noopener noreferrer')

  return defaultLinkOpen(tokens, idx, options, env, self)
}

/**
 * 将 Markdown 文本渲染为经过 XSS 清洗的安全 HTML。
 * @param content 原始 Markdown 文本
 */
export function renderMarkdown(content: string): string {
  if (!content) {
    return ''
  }

  const rawHtml = md.render(content)
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel'],
  })
}
