// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'

// pdfjs-dist 在 node/happy-dom 下模块加载即因缺少 DOMMatrix 报错（canvas.js）。
// 文本分发测试不触及 pdf 解析路径，mock 掉 pdfjs 以隔离。
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }),
}))

import { extractFileText } from '../src/utils/fileText'

// 文件文本提取分发测试：覆盖文本类、旧版提示、未知类型。
// 不覆盖 pdf/docx/xlsx/pptx（依赖重库与真实二进制，留集成测试）。
function makeFile(name: string, content: string, type = 'text/plain'): File {
  return new File([content], name, { type })
}

describe('extractFileText 文本类分发', () => {
  it('txt 原样返回', async () => {
    expect(await extractFileText(makeFile('a.txt', 'hello world'))).toBe('hello world')
  })
  it('md 原样返回', async () => {
    expect(await extractFileText(makeFile('a.md', '# title'))).toBe('# title')
  })
  it('csv 原样返回', async () => {
    expect(await extractFileText(makeFile('a.csv', 'a,b\n1,2'))).toBe('a,b\n1,2')
  })
  it('json 原样返回', async () => {
    expect(await extractFileText(makeFile('a.json', '{"x":1}'))).toBe('{"x":1}')
  })
  it('代码类（ts）原样返回', async () => {
    const code = 'export const x = 1'
    expect(await extractFileText(makeFile('a.ts', code))).toBe(code)
  })
})

describe('extractFileText 边界与提示', () => {
  it('超大文本被截断并标注原文字符数', async () => {
    const big = 'a'.repeat(100_001)
    const out = await extractFileText(makeFile('big.txt', big))
    expect(out).toContain('已截断')
    expect(out).toContain('100001')
  })
  it('旧版 doc 给提示', async () => {
    const out = await extractFileText(makeFile('a.doc', '', 'application/msword'))
    expect(out).toContain('旧版 .doc')
  })
  it('旧版 ppt 给提示', async () => {
    const out = await extractFileText(makeFile('a.ppt', '', 'application/vnd.ms-powerpoint'))
    expect(out).toContain('旧版 .ppt')
  })
  it('未知类型给提示', async () => {
    const out = await extractFileText(makeFile('a.xyz', 'xx', 'application/octet-stream'))
    expect(out).toContain('未识别')
  })
})
