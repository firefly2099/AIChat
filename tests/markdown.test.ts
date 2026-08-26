// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../src/utils/markdown'

// 前端 Markdown 渲染测试（happy-dom 提供 window 给 DOMPurify）。
// 注：happy-dom 下 DOMPurify 会剥离 <h1>/<pre> 等块级标签（浏览器正常），
// 故断言只校验稳定的内容、行内属性与 XSS，不依赖块级标签结构。
describe('renderMarkdown', () => {
  it('空输入返回空串', () => {
    expect(renderMarkdown('')).toBe('')
  })

  it('标题文本被渲染出来', () => {
    expect(renderMarkdown('# 你好')).toContain('你好')
  })

  it('围栏代码块带 hljs 与语言 class', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```')
    expect(html).toContain('class="hljs language-js"')
    expect(html).toContain('const')
  })

  it('无语言围栏代码块仍带 hljs class', () => {
    expect(renderMarkdown('```\nplain code\n```')).toContain('class="hljs"')
  })

  it('行内代码带 hljs inline class', () => {
    const html = renderMarkdown('这是 `code` 代码')
    expect(html).toContain('class="hljs inline"')
    expect(html).toContain('code')
  })

  it('linkify 裸链接并强制新标签打开', () => {
    const html = renderMarkdown('见 https://example.com 详情')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('XSS 清洗：无 <script> 标签', () => {
    const html = renderMarkdown('<script>alert(1)</script>').toLowerCase()
    expect(html).not.toContain('<script')
  })
})
