// 文件文本提取：把用户上传的 pdf / docx / xlsx / pptx / 文本类文件转成可拼进 LLM prompt 的纯文本。
import * as pdfjsLib from 'pdfjs-dist'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
// Vite 把 worker 作为 URL 引入，pdfjs 需要它在独立线程运行
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

// 单文件提取文本上限：避免把超大文档撑爆 prompt
// 节省 tokens：单文件提取文本上限 2 万字符（约 5k tokens）。
// 多文件总量另由 ChatView 的总文本上限二次约束。
const MAX_CHARS_PER_FILE = 20_000

// 纯文本类扩展名：可直接按 UTF-8 读取，无需解析库
const TEXT_EXTENSIONS = new Set<string>([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'json5',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'vue',
  'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
  'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'bat', 'ps1',
  'yml', 'yaml', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'sql', 'ini', 'conf', 'cfg', 'log', 'env', 'toml', 'properties',
  'svg', 'gitignore', 'dockerfile', 'makefile',
])

function getExt(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx < 0) return name.toLowerCase() // 无扩展名（如 Dockerfile）按全名小写
  return name.slice(idx + 1).toLowerCase()
}

function truncate(text: string, max = MAX_CHARS_PER_FILE): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n…（已截断，原文共 ${text.length} 字符）`
}

// 反转常见 XML 实体，用于 PPTX 文本节点解码
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function readAsText(file: File): Promise<string> {
  return truncate(await file.text())
}

async function extractPdf(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const parts: string[] = []
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    parts.push(content.items.map((item) => ('str' in item ? (item as { str: string }).str : '')).join(' '))
  }
  return truncate(parts.join('\n'))
}

async function extractDocx(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer: buf })
  return truncate(result.value || '')
}

async function extractXlsx(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (sheet) parts.push(`### Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`)
  }
  return truncate(parts.join('\n\n'))
}

async function extractPptx(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const zip = await new JSZip().loadAsync(buf)
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)![1], 10)
      const nb = parseInt(b.match(/slide(\d+)\.xml/)![1], 10)
      return na - nb
    })
  const parts: string[] = []
  for (const sf of slideFiles) {
    const xml = await zip.files[sf].async('string')
    // PowerPoint 文本运行节点：<a:t>...</a:t>（可能带属性）
    const runs = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || []
    const text = runs
      .map((r) => decodeXmlEntities(r.replace(/^<a:t[^>]*>/, '').replace(/<\/a:t>$/, '')))
      .join('')
    if (text) parts.push(text)
  }
  return truncate(parts.join('\n'))
}

/**
 * 提取文件文本内容，用于拼进 LLM prompt。
 * DeepSeek 不能直接读二进制，因此文档类用前端库提取文本。
 * 不支持的格式返回说明文本（不抛错，避免中断发送）。
 */
export async function extractFileText(file: File): Promise<string> {
  const ext = getExt(file.name)
  try {
    if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/')) {
      return await readAsText(file)
    }
    if (ext === 'pdf') return await extractPdf(file)
    if (ext === 'docx') return await extractDocx(file)
    if (ext === 'doc') return '【旧版 .doc 二进制格式暂不支持文本提取，请另存为 .docx 后再上传。】'
    if (ext === 'xlsx' || ext === 'xls') return await extractXlsx(file)
    if (ext === 'pptx') return await extractPptx(file)
    if (ext === 'ppt') return '【旧版 .ppt 二进制格式暂不支持文本提取，请另存为 .pptx 后再上传。】'
    return `【未识别的文件类型（${ext || file.type || '未知'}），无法提取文本。】`
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return `【解析 ${file.name} 失败：${msg.slice(0, 120)}】`
  }
}
