<script setup lang="ts">
import { Top } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiUrl, buildAuthHeaders, fetchSessionById, saveSessionSnapshot } from '../api/chatApi'
import ComposerPanel from '../components/ComposerPanel.vue'
import ImagePreviewModal from '../components/ImagePreviewModal.vue'
import { useModelStore } from '../store/modelStore'
import { buildSessionTitleByPrompt, getSession, loadMessageExtras, saveSession, saveMessageExtras, takePendingAttachments } from '../store/sessionStore'
import { renderMarkdown } from '../utils/markdown'
import { extractFileText } from '../utils/fileText'

type AttachmentItem = {
  file: File
  url: string
}

/**
 * 聊天消息对象。
 * role 区分用户消息与助手回复，便于渲染左右气泡布局。
 */
type Message = {
  id: number
  role: 'user' | 'assistant'
  content: string
  // 用户上传的图片附件（base64 data URL）。
  // url 用于气泡展示，mime 在重新生成/继续生成时恢复 streamReply 的 images 参数（后端上传 Files API 需要）。
  attachments?: { url: string; mime: string }[]
  // 非图片文件的元信息（名称/大小），仅用于气泡展示，文本内容见 fileContext
  files?: { name: string; size: number }[]
  // 非图片文件提取的文本，发送时拼进 prompt；重新生成/继续生成时一并带上
  fileContext?: string
}

const route = useRoute()
const router = useRouter()
const modelStore = useModelStore()

/**
 * 当前选中的模型 ID。
 */
const selectedModel = computed({
  get: () => modelStore.selectedModel || 'deepseek-v3',
  set: (value: string) => modelStore.setSelectedModel(value),
})

/**
 * 输入框内容。
 */
const input = ref('')
const chatComposerRef = ref<InstanceType<typeof ComposerPanel> | null>(null)
const chatComposerShellInnerRef = ref<HTMLElement | null>(null)
const chatLayoutRef = ref<HTMLElement | null>(null)

/**
 * 绑定文本框引用，由于需要在不同逻辑中自动聚焦输入框。
 */
const attachments = ref<AttachmentItem[]>([])
const previewAttachmentIndex = ref<number | null>(null)
const showImagePreview = ref(false)
// 已发送气泡图片的预览 URL（复用 ImagePreviewModal，独立于 composer 附件预览）
const bubbleImagePreviewUrl = ref<string>('')
const showFilePreview = ref(false)
const ATTACHMENT_ONLY_PROMPT = '请结合我上传的附件内容进行分析。'

/**
 * 当前会话中的消息列表。
 */
const messages = ref<Message[]>([])

/**
 * 标识当前是否存在正在流式输出的请求。
 */
const isStreaming = ref(false)
const isPaused = ref(false)
const isManualStop = ref(false)
const isSessionLoading = ref(false)

/* -------------------------------------------------------------------------- */
/*  mode-buttons 选中态持久化（sessionStorage）                                */
/* -------------------------------------------------------------------------- */
const MODE_BUTTONS_STORAGE_KEY = 'aichat:composer:mode-buttons:v1'
type ModeButtonsState = { thinkingEnabled: boolean; searchEnabled: boolean }
const MODE_BUTTONS_DEFAULT: ModeButtonsState = { thinkingEnabled: false, searchEnabled: false }

// 恢复门禁：从 sessionStorage 只读恢复完成前，不把初始值/中间值写回，避免覆盖历史缓存
let modeButtonsHydrated = false

function loadModeButtons(): ModeButtonsState {
  if (typeof window === 'undefined') return { ...MODE_BUTTONS_DEFAULT }
  try {
    const raw = window.sessionStorage.getItem(MODE_BUTTONS_STORAGE_KEY)
    if (!raw) return { ...MODE_BUTTONS_DEFAULT }
    const obj = JSON.parse(raw) as Partial<ModeButtonsState>
    return {
      thinkingEnabled: obj?.thinkingEnabled === true,
      searchEnabled: obj?.searchEnabled === true,
    }
  } catch {
    return { ...MODE_BUTTONS_DEFAULT }
  }
}

function saveModeButtons(state: ModeButtonsState) {
  if (typeof window === 'undefined') return
  if (!modeButtonsHydrated) return // 恢复门禁：hydrated 前禁止写回
  try {
    window.sessionStorage.setItem(MODE_BUTTONS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // storage 满/隐私模式忽略
  }
}

// 先以默认值占位，onMounted/setup 后在 watch immediate 前再用 load 覆盖
const thinkingEnabled = ref<boolean>(MODE_BUTTONS_DEFAULT.thinkingEnabled)
const searchEnabled = ref<boolean>(MODE_BUTTONS_DEFAULT.searchEnabled)

/**
 * 当前会话标题，默认是“新对话”。
 */
const chatTitle = ref('新对话')

/**
 * 当前流式请求对应的 AbortController，用于取消请求。
 */
const currentStreamAbort = ref<AbortController | null>(null)
const lastUserPrompt = ref('')

/**
 * 记录“已触发过的 prompt”，避免返回到同一会话时重复发送。
 */
const autoStreamedSessions = new Set<string>()
const AUTO_STREAM_LOCK_PREFIX = 'aichat_auto_stream_lock:'

const buildAutoStreamKey = (id: string, prompt: string) => `${id}:${prompt}`

const hasAutoStreamLock = (id: string, prompt: string) => {
  if (typeof window === 'undefined') {
    return autoStreamedSessions.has(buildAutoStreamKey(id, prompt))
  }

  const key = `${AUTO_STREAM_LOCK_PREFIX}${buildAutoStreamKey(id, prompt)}`
  return autoStreamedSessions.has(buildAutoStreamKey(id, prompt)) || window.sessionStorage.getItem(key) === '1'
}

const setAutoStreamLock = (id: string, prompt: string) => {
  const key = buildAutoStreamKey(id, prompt)
  autoStreamedSessions.add(key)

  if (typeof window === 'undefined') {
    return
  }

  window.sessionStorage.setItem(`${AUTO_STREAM_LOCK_PREFIX}${key}`, '1')
}

const sessionID = computed(() => String(route.params.sessionID || ''))
const pendingPrompt = computed(() => String(route.query.prompt || ''))
const pendingThinking = computed(() => String(route.query.thinking_enabled || ''))
const pendingSearch = computed(() => String(route.query.search_enabled || ''))

const hasConversation = computed(() => messages.value.length > 0)
const canSend = computed(() => input.value.trim().length > 0 || attachments.value.length > 0)
const sendButtonDisabled = computed(() => !isStreaming.value && !canSend.value)
const sendButtonActive = computed(() => isStreaming.value || canSend.value)
const sendButtonLoading = computed(() => isStreaming.value)
const showContinueButton = computed(() => isPaused.value && hasConversation.value)
const BASE_COMPOSER_SAFE_SPACE = 180
const composerSafeSpace = ref(BASE_COMPOSER_SAFE_SPACE)
const chatLayoutStyle = computed(() => ({
  '--composer-safe-space': `${composerSafeSpace.value}px`,
}))
const previewAttachment = computed(() => {
  if (previewAttachmentIndex.value == null) {
    return null
  }

  return attachments.value[previewAttachmentIndex.value] ?? null
})
const isImageAttachment = computed(() => !!previewAttachment.value?.file.type.startsWith('image/'))
const isFileAttachment = computed(() => !!previewAttachment.value && !isImageAttachment.value)

let composerResizeObserver: ResizeObserver | null = null
const AUTO_SCROLL_THRESHOLD = 72
const shouldAutoScroll = ref(true)
let autoScrollRafId: number | null = null
let anchorSyncRafId: number | null = null

// ---- 右侧对话定位锚点 ----
// active 由滚动位置联动决定（不被 hover 覆盖），hover 独立控制，两种状态可共存
const activeAnchorId = ref<number | null>(null)
const hoveredAnchorId = ref<number | null>(null)
const flashingMessageId = ref<number | null>(null)

// 提取用户消息作为锚点，预览截取前 40 字，不换行
const userMessageAnchors = computed(() =>
  messages.value
    .filter((m) => m.role === 'user')
    .map((m) => ({
      id: m.id,
      preview: m.content
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40) || '用户消息',
    })),
)

/**
 * 点击锚点跳转到指定消息行，并触发一次不明显的闪烁提示
 */
const jumpToMessage = (msgId: number) => {
  // 用 getElementById 而非 querySelector：id 由 Date.now()+Math.random() 生成，
  // 形如 1787630629864.2769，querySelector 会把 .2769 误判为类名导致 SyntaxError
  const targetEl = document.getElementById(`msg-${msgId}`) as HTMLElement | null
  if (!targetEl) return

  targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flashingMessageId.value = msgId
  // 闪烁 1.6 秒，不打断用户
  window.setTimeout(() => {
    flashingMessageId.value = null
  }, 1600)
}

/**
 * 根据当前滚动位置，计算处于可视区中心的用户消息并同步激活对应锚点
 * 用于页面滚动或鼠标离开锚点区时，让激活态回到真实位置
 */
const syncActiveAnchorByScroll = () => {
  const container = chatLayoutRef.value
  if (!container) return

  const containerRect = container.getBoundingClientRect()
  const viewportCenter = containerRect.top + containerRect.height / 2

  let closest = { id: null as number | null, distance: Infinity }
  for (const m of messages.value) {
    if (m.role !== 'user') continue
    // 用 getElementById 而非 querySelector：id 由 Date.now()+Math.random() 生成，
    // 形如 1787631359052.2263，querySelector 会把 .2263 误判为类名导致 SyntaxError
    const el = document.getElementById(`msg-${m.id}`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    const msgCenter = r.top + r.height / 2
    const d = Math.abs(msgCenter - viewportCenter)
    if (d < closest.distance) {
      closest = { id: m.id, distance: d }
    }
  }
  activeAnchorId.value = closest.id
}

const getDistanceToBottom = () => {
  const el = chatLayoutRef.value
  if (!el) {
    return 0
  }

  return el.scrollHeight - el.scrollTop - el.clientHeight
}

const handleChatLayoutScroll = () => {
  shouldAutoScroll.value = getDistanceToBottom() <= AUTO_SCROLL_THRESHOLD
  // 滚动时同步锚点激活态（节流：rAF）
  if (anchorSyncRafId == null) {
    anchorSyncRafId = requestAnimationFrame(() => {
      anchorSyncRafId = null
      syncActiveAnchorByScroll()
    })
  }
}

const scrollChatToBottom = (force = false) => {
  const el = chatLayoutRef.value
  if (!el) {
    return
  }

  if (!force && !shouldAutoScroll.value) {
    return
  }

  el.scrollTop = el.scrollHeight
}

const scheduleScrollToBottom = (force = false) => {
  if (autoScrollRafId != null) {
    cancelAnimationFrame(autoScrollRafId)
  }

  autoScrollRafId = requestAnimationFrame(() => {
    scrollChatToBottom(force)
    autoScrollRafId = null
  })
}

/**
 * 根据输入区壳层实时高度，动态更新消息区底部安全间距。
 * 默认不小于 180px，避免短输入框时底部空间不足。
 */
const updateComposerSafeSpace = () => {
  const shellHeight = chatComposerShellInnerRef.value?.offsetHeight ?? 0
  composerSafeSpace.value = Math.max(BASE_COMPOSER_SAFE_SPACE, shellHeight + 20)
}

const bindComposerResizeObserver = () => {
  if (typeof ResizeObserver === 'undefined' || !chatComposerShellInnerRef.value) {
    return
  }

  composerResizeObserver?.disconnect()
  composerResizeObserver = new ResizeObserver(() => {
    updateComposerSafeSpace()
  })
  composerResizeObserver.observe(chatComposerShellInnerRef.value)
}

const clearAttachment = () => {
  for (const item of attachments.value) {
    URL.revokeObjectURL(item.url)
  }
  attachments.value = []
  previewAttachmentIndex.value = null
  showImagePreview.value = false
  showFilePreview.value = false
}

/**
 * 附件移除后的联动处理：ComposerPanel 已负责 splice + revokeObjectURL，
 * 父组件只需修正预览索引与图片/文件预览弹窗状态。
 */
const handleRemoveAttachment = (index: number) => {
  if (previewAttachmentIndex.value == null) {
    return
  }

  if (attachments.value.length === 0) {
    previewAttachmentIndex.value = null
    showImagePreview.value = false
    showFilePreview.value = false
    return
  }

  if (previewAttachmentIndex.value === index) {
    previewAttachmentIndex.value = Math.min(index, attachments.value.length - 1)
    const current = attachments.value[previewAttachmentIndex.value]
    const isImage = !!current?.file.type.startsWith('image/')
    showImagePreview.value = isImage
    showFilePreview.value = !isImage
    return
  }

  if (previewAttachmentIndex.value > index) {
    previewAttachmentIndex.value -= 1
  }
}

/**
 * 附件点击预览：图片弹窗、文件显示右侧预览区。
 */
const openAttachmentPreview = (index: number) => {
  const target = attachments.value[index]
  if (!target) {
    return
  }

  previewAttachmentIndex.value = index

  if (target.file.type.startsWith('image/')) {
    showImagePreview.value = true
    showFilePreview.value = false
    return
  }

  showImagePreview.value = false
  showFilePreview.value = true
}

/**
 * 布尔查询参数标准化。
 * @param {string} raw 查询参数
 * @returns {boolean}
 */
const parseQueryBoolean = (raw: string) => raw === 'true' || raw === '1'

/**
 * 切换“深度思考”开关。
 */
const toggleThinking = () => {
  thinkingEnabled.value = !thinkingEnabled.value
}

/**
 * 切换“智能搜索”开关。
 */
const toggleSearch = () => {
  searchEnabled.value = !searchEnabled.value
}

/**
 * mode-buttons 统一落盘入口：变化即写 sessionStorage，刷新不丢。
 */
watch(
  [thinkingEnabled, searchEnabled],
  ([t, s]) => {
    saveModeButtons({ thinkingEnabled: Boolean(t), searchEnabled: Boolean(s) })
  },
  { flush: 'post' },
)

/**
 * 生成唯一消息 ID。
 * 结合 Date.now 与随机值，避免同时间内出现重复 ID。
 */
const nextMessageId = () => Date.now() + Math.random()

/**
 * 将 File 转为 base64 data URL，用于向支持多模态的模型发送图片。
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * 处理附件：图片转 base64（随流式请求发给后端），文档提取文本拼进 prompt。
 * 首页发送与聊天页发送共用此逻辑，保证两条路径行为一致。
 */
async function processAttachments(files: File[]): Promise<{
  imageData: { url: string; mime: string }[]
  files: { name: string; size: number }[]
  fileContext?: string
}> {
  const imageData: { url: string; mime: string }[] = []
  const fileMeta: { name: string; size: number }[] = []
  const fileTextParts: string[] = []
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      imageData.push({ url: await fileToBase64(file), mime: file.type })
    } else {
      fileMeta.push({ name: file.name, size: file.size })
      const text = await extractFileText(file)
      if (text) fileTextParts.push(`===== 附件：${file.name} =====\n${text}`)
    }
  }
  // 节省 tokens：所有文档提取文本拼接后，单次请求总量不超过 2 万字符，超出截断并标注。
  // 与后端 MAX_MESSAGE_LENGTH 对齐，避免发出去又被后端截掉。
  const MAX_TOTAL_FILE_CHARS = 20_000
  let fileContext = fileTextParts.length > 0 ? fileTextParts.join('\n\n') : undefined
  if (fileContext && fileContext.length > MAX_TOTAL_FILE_CHARS) {
    fileContext = `${fileContext.slice(0, MAX_TOTAL_FILE_CHARS)}\n\n…（已截断：附件文本超过 ${MAX_TOTAL_FILE_CHARS} 字符，仅保留前部分）`
  }
  return { imageData, files: fileMeta, fileContext }
}

/**
 * 基于扩展名生成文件类型标签（PDF/DOCX/XLSX…），用于气泡文件卡片图标文案。
 */
const getFileTypeTag = (name: string) => {
  const lastDot = name.lastIndexOf('.')
  if (lastDot < 0 || lastDot === name.length - 1) {
    return 'FILE'
  }
  return name.slice(lastDot + 1, lastDot + 5).toUpperCase()
}

/**
 * 将附件大小格式化为可读文案（KB/MB）。
 */
const formatAttachmentSize = (size: number) => {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

/**
 * 聚焦当前输入框，常用于流式响应结束或进入页面后的自动聚焦。
 */
const focusInput = () => {
  nextTick(() => {
    const composer = chatComposerRef.value
    composer?.focusInput()
    composer?.resizeComposer()
  })
}

/**
 * 远程快照保存的防抖句柄与挂起的快照数据。
 * 流式输出会高频触发持久化，使用防抖避免每个 token 都打一次后端库。
 * pendingSnapshot 捕获触发时的会话快照副本，确保切换会话后仍能把上一个会话的最新内容落库。
 */
let remoteSnapshotTimer: ReturnType<typeof setTimeout> | null = null
let pendingSnapshot: {
  id: string
  title: string
  modelId: string
  thinkingEnabled: boolean
  searchEnabled: boolean
  messages: Message[]
} | null = null
const REMOTE_SNAPSHOT_DEBOUNCE_MS = 800

/**
 * 立即把挂起的会话快照写入后端，并取消防抖任务。
 * 用于流式结束、停止生成、切换会话、组件卸载等需要确保落库的时机。
 */
const flushRemoteSnapshot = async () => {
  if (remoteSnapshotTimer != null) {
    clearTimeout(remoteSnapshotTimer)
    remoteSnapshotTimer = null
  }

  const snapshot = pendingSnapshot
  pendingSnapshot = null
  if (!snapshot) return

  // 快照落库前，先把附件扩展信息（图片/文件/提取文本）写入 localStorage。
  // 后端不存这些字段，刷新后需靠本地按下标合并回消息。
  // 用客户端消息 id 匹配快照数组下标，保证下标与后端 sort_order 对齐。
  const extrasById = new Map<number, { attachments?: { url: string; mime: string }[]; files?: { name: string; size: number }[]; fileContext?: string }>()
  for (const m of messages.value) {
    if (m.attachments?.length || m.files?.length || m.fileContext) {
      extrasById.set(m.id, { attachments: m.attachments, files: m.files, fileContext: m.fileContext })
    }
  }
  const extrasByIndex: Record<number, { attachments?: { url: string; mime: string }[]; files?: { name: string; size: number }[]; fileContext?: string }> = {}
  snapshot.messages.forEach((m, i) => {
    const ex = extrasById.get(m.id)
    if (ex) extrasByIndex[i] = ex
  })
  saveMessageExtras(snapshot.id, extrasByIndex)

  try {
    await saveSessionSnapshot(snapshot.id, {
      title: snapshot.title,
      modelId: snapshot.modelId,
      thinkingEnabled: snapshot.thinkingEnabled,
      searchEnabled: snapshot.searchEnabled,
      messages: snapshot.messages,
    })
  } catch (error) {
    console.warn('会话快照保存失败，将在后续操作重试:', error)
  }
}

/**
 * 防抖式远程保存：流式过程中频繁触发时，只会在停顿后写一次库。
 * 每次调用都会刷新挂起的快照副本与计时器。
 */
const scheduleRemoteSnapshot = () => {
  if (!sessionID.value) return

  pendingSnapshot = {
    id: sessionID.value,
    title: chatTitle.value,
    modelId: selectedModel.value,
    thinkingEnabled: thinkingEnabled.value,
    searchEnabled: searchEnabled.value,
    // 剥离 attachments：base64 仅用于本地气泡展示，不写后端避免快照膨胀
    messages: messages.value.map((m) => ({ id: m.id, role: m.role, content: m.content })),
  }

  if (remoteSnapshotTimer != null) {
    clearTimeout(remoteSnapshotTimer)
  }

  remoteSnapshotTimer = setTimeout(() => {
    remoteSnapshotTimer = null
    void flushRemoteSnapshot()
  }, REMOTE_SNAPSHOT_DEBOUNCE_MS)
}

/**
 * 持久化当前会话状态：
 * - 本地 sessionMap 立即更新，保证切换路由/刷新前数据最新；
 * - 远程落库走防抖，避免流式逐字写库造成数据库压力。
 */
const persistSession = async () => {
  if (!sessionID.value) return

  const snapshot = {
    id: sessionID.value,
    title: chatTitle.value,
    modelId: selectedModel.value,
    thinkingEnabled: thinkingEnabled.value,
    searchEnabled: searchEnabled.value,
    messages: messages.value,
  }

  saveSession(snapshot)
  scheduleRemoteSnapshot()
}

/**
 * 根据 sessionID 恢复会话。
 * 若当前路由携带了 prompt，则视为新消息并自动发送，避免首页和聊天页重复写入用户消息。
 */
const restoreSession = async (id: string) => {
  // 切换会话前先把上一个会话挂起的快照落库，避免本地最新内容被旧的后端数据覆盖
  void flushRemoteSnapshot()
  isSessionLoading.value = true
  messages.value = []

  let target = null
  // 标记远端是否明确返回"会话不存在"（404），用于区分"用户输入了不存在的 ID"
  // 与"网络故障/后端 500"——前者应提示并重定向，后者维持原空白兜底等待重试。
  let remoteNotFound = false

  // 优先使用后端会话，避免本地缓存（尤其是新建空会话）导致刷新后重复自动发送。
  try {
    target = await fetchSessionById(id)
    saveSession(target)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // 后端 404 返回"会话不存在"视为会话不存在；网络错误/500 等不算。
    remoteNotFound = /不存在|404/.test(msg)
    if (!remoteNotFound) {
      console.warn('远端会话恢复失败，回退本地缓存:', error)
    }
    target = getSession(id)
  }

  if (!target) {
    // 远端明确不存在且本地也无缓存：用户手动输入了不存在的会话 ID。
    // 提示并重定向到首页，避免 URL 携留伪造 ID、后续发消息又把该 ID 建成新会话。
    if (remoteNotFound) {
      ElMessage.warning('该会话不存在，已返回首页，请重新选择或新建会话。')
      isSessionLoading.value = false
      void router.replace({ name: 'home' })
      return
    }
    // 远端不可用且本地也无缓存：维持原"空白新对话"兜底，等用户发消息时再建会话。
    messages.value = []
    chatTitle.value = '新对话'
    selectedModel.value = 'deepseek-v3'
    isSessionLoading.value = false
    return
  }

  selectedModel.value = target.modelId || 'deepseek-v3'

  /*
   * mode-buttons 优先级（从低到高）：
   *   1) sessionStorage 中全局默认（用户上一次手动切换的全局状态）
   *   2) 会话自身保存的 thinkingEnabled / searchEnabled（会话级粒度）
   *   3) route.query 上带的 thinking_enabled / search_enabled（外链跳转/新标签页触发）
   */
  const defaults = modeButtonsHydrated
    ? { thinkingEnabled: thinkingEnabled.value, searchEnabled: searchEnabled.value }
    : loadModeButtons()
  const sessionLevel = {
    thinkingEnabled: target.thinkingEnabled === true,
    searchEnabled: target.searchEnabled === true,
  }
  // 会话自身的思考/搜索状态只要 true 就覆盖默认；用户有会话级偏好就遵循。
  let nextThinking = sessionLevel.thinkingEnabled || defaults.thinkingEnabled
  let nextSearch = sessionLevel.searchEnabled || defaults.searchEnabled

  if (pendingThinking.value) nextThinking = parseQueryBoolean(pendingThinking.value)
  if (pendingSearch.value) nextSearch = parseQueryBoolean(pendingSearch.value)

  thinkingEnabled.value = nextThinking
  searchEnabled.value = nextSearch
  // restoreSession 可能在 onMounted 前由 watch immediate 触发，
  // 这里开门禁，保证后续用户手动切换能写入 sessionStorage。
  if (!modeButtonsHydrated) modeButtonsHydrated = true

  messages.value = target.messages || []
  // 合并本地附件扩展信息（图片 base64 / 文件元信息 / 提取文本）：
  // 后端 chat_messages 不存这些字段，刷新后靠 localStorage 按下标补回。
  const extras = loadMessageExtras(id)
  if (Object.keys(extras).length > 0) {
    messages.value = messages.value.map((m, i): Message => {
      const ex = extras[i]
      if (!ex) return { ...m } as Message
      return { ...m, attachments: ex.attachments, files: ex.files, fileContext: ex.fileContext } as Message
    })
  }
  chatTitle.value = target.title || '新对话'

  const prompt = pendingPrompt.value.trim()
  const hasHistoryMessages = Array.isArray(target.messages) && target.messages.length > 0
  const hasSameLastUserPrompt =
    messages.value.length > 0 &&
    messages.value[messages.value.length - 1]?.role === 'user' &&
    messages.value[messages.value.length - 1]?.content === prompt
  const shouldAutoStream = !!prompt && !hasHistoryMessages && !hasSameLastUserPrompt && !hasAutoStreamLock(id, prompt)

  if (shouldAutoStream) {
    setAutoStreamLock(id, prompt)
    // 取出首页暂存的附件（如有），处理后拼进消息与请求，保证首页发送的图片/文档不丢失
    const pendingFiles = takePendingAttachments(id) ?? []
    const { imageData, files, fileContext } = pendingFiles.length
      ? await processAttachments(pendingFiles)
      : { imageData: [], files: [], fileContext: undefined }
    const sendText = fileContext ? `${prompt}\n\n${fileContext}` : prompt

    messages.value = [
      {
        id: Date.now(),
        role: 'user',
        content: prompt,
        attachments: imageData.length ? imageData : undefined,
        files: files.length ? files : undefined,
        fileContext,
      },
    ]
    chatTitle.value = buildSessionTitleByPrompt(prompt)
    saveSession({
      id,
      title: chatTitle.value,
      modelId: selectedModel.value,
      messages: messages.value,
    })

    nextTick(() => {
      void streamReply(sendText, { images: imageData.length ? imageData : undefined })
    })

    router.replace({
      name: 'chat',
      params: { sessionID: id },
      query: {},
    })
  }

  isSessionLoading.value = false
}

/**
 * 创建一个空白助手消息占位，用于流式输出追加内容。
 */
function createAssistantMessage() {
  const item: Message = {
    id: nextMessageId(),
    role: 'assistant',
    content: '',
  }
  messages.value.push(item)
  void persistSession()
  scheduleScrollToBottom(true)
  return messages.value[messages.value.length - 1]
}

/**
 * 获取最后一条助手消息。
 * 用于“继续生成”时在原有回复尾部继续追加内容。
 * @returns {Message | null}
 */
function getLastAssistantMessage() {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i].role === 'assistant') {
      return messages.value[i]
    }
  }
  return null
}

/**
 * 返回最后一条用户消息（对象而非仅文本），便于调用方读取 content / attachments / fileContext。
 * 用于重新生成 / 继续生成时恢复完整请求参数（含图片 images），与 handleSend 首次发送链路一致。
 */
function getLastUserMessage(): Message | undefined {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i].role === 'user') return messages.value[i]
  }
  return undefined
}

function getLastUserPrompt() {
  const m = getLastUserMessage()
  if (!m) return ''
  // 文件文本拼回 prompt，保证重新生成/继续生成带上附件内容
  return m.fileContext ? `${m.content}\n\n${m.fileContext}` : m.content
}

/**
 * 构造继续生成的提示词，让模型从已输出末尾继续。
 * @returns {string}
 */
function buildContinuePrompt() {
  const basePrompt = lastUserPrompt.value || getLastUserPrompt()
  const partialAnswer = (getLastAssistantMessage()?.content || '').slice(-500)

  if (!basePrompt) {
    return ''
  }

  return [
    `原始问题：${basePrompt}`,
    '你上一次回答中断了。',
    `已输出内容（末尾片段）：${partialAnswer || '（无）'}`,
    '请从中断处继续输出，不要重复已经输出的文本。',
  ].join('\n')
}

/**
 * 向后端发起流式消息请求，并边接收边追加到 assistant 消息中。
 * @param userText 用户输入的消息内容
 */
async function streamReply(userText: string, options: { reuseLastAssistant?: boolean; isContinue?: boolean; images?: { url: string; mime: string }[] } = {}) {
  if (isStreaming.value) return

  isStreaming.value = true
  isManualStop.value = false
  isPaused.value = false

  if (!options.isContinue) {
    lastUserPrompt.value = userText
  }

  const assistantMessage = options.reuseLastAssistant
    ? getLastAssistantMessage() || createAssistantMessage()
    : createAssistantMessage()

  const controller = new AbortController()
  currentStreamAbort.value = controller
  let shouldKeepPausedState = false

  // 流式请求超时保护：60 秒内收不到数据则主动中断，防止连接挂死
  const streamTimeout = setTimeout(() => {
    if (isStreaming.value) {
      isManualStop.value = true
      controller.abort()
    }
  }, 60_000)

  try {
    // 改用 POST 提交，避免长消息触发 URL 长度限制
    const streamHeaders = buildAuthHeaders()
    streamHeaders.set('Content-Type', 'application/json')

    const response = await fetch(apiUrl('/api/chat/stream'), {
      method: 'POST',
      headers: streamHeaders,
      body: JSON.stringify({
        model: selectedModel.value,
        message: userText,
        thinkingEnabled: thinkingEnabled.value,
        searchEnabled: searchEnabled.value,
        images: options.images,
      }),
      signal: controller.signal,
    })

    clearTimeout(streamTimeout)

    if (!response.ok) {
      let errorText = '模型服务暂时不可用，请稍后再试。'

      try {
        const payload = await response.json()
        errorText = payload?.error || payload?.message || errorText
      } catch {
        const fallbackText = await response.text()
        errorText = fallbackText || errorText
      }

      assistantMessage.content = errorText
      void persistSession()
      throw new Error(errorText)
    }

    if (!response.body) {
      throw new Error('响应流不存在')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let receivedData = false

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        const trimmed = part.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue

        const raw = trimmed.slice(5).trim()
        if (!raw || raw === '[DONE]') continue

        try {
          const payload = JSON.parse(raw)

          if (payload.type === 'chunk') {
            receivedData = true
            assistantMessage.content += payload.text || ''
            void persistSession()
            scheduleScrollToBottom()
            continue
          }

          if (payload.type === 'error') {
            const errorText = payload.text || '抱歉，当前模型暂时不可用。'
            assistantMessage.content = errorText
            void persistSession()
            throw new Error(errorText)
          }

          if (payload.type === 'done') {
            receivedData = true
          }
        } catch (parseError) {
          // done 事件或其他非 chunk/error 类型忽略，不阻断流
          if (parseError instanceof Error && parseError.message.includes('JSON')) {
            console.warn('解析流式事件失败:', raw, parseError)
          }
        }
      }
    }

    // 超时但未收到任何数据的兜底提示
    if (!receivedData && !isManualStop.value) {
      assistantMessage.content = assistantMessage.content || '模型服务响应超时，请稍后重试。'
    }

    void persistSession()
    focusInput()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && isManualStop.value) {
      shouldKeepPausedState = true
      isPaused.value = true
      void persistSession()
      focusInput()
      return
    }

    if (error instanceof Error && error.name === 'AbortError') {
      // 超时导致的中断
      assistantMessage.content = assistantMessage.content || '请求超时，请稍后重试。'
      void persistSession()
      focusInput()
      return
    }

    if (error instanceof Error && error.name !== 'AbortError') {
      assistantMessage.content = assistantMessage.content || '抱歉，消息流连接失败，请稍后再试。'
      void persistSession()
      focusInput()
    }
  } finally {
    // 确保超时定时器被清理，避免已结束的请求超时误触发
    clearTimeout(streamTimeout)
    currentStreamAbort.value = null
    isStreaming.value = false
    isManualStop.value = false
    if (!shouldKeepPausedState) {
      isPaused.value = false
    }
    // 流式结束立即落库，取消挂起的防抖任务
    void flushRemoteSnapshot()
    focusInput()
  }
}

/**
 * 主动停止流式输出。
 */
function stopGeneration() {
  if (!isStreaming.value || !currentStreamAbort.value) {
    return
  }

  isManualStop.value = true
  currentStreamAbort.value.abort()
}

/**
 * 从停止处继续生成。
 */
async function continueGeneration() {
  if (isStreaming.value || !isPaused.value) {
    return
  }

  const continuePrompt = buildContinuePrompt()
  if (!continuePrompt) {
    return
  }

  // 继续生成也要带上图片（与首次发送链路一致），否则模型收不到图会提示未看到附件。
  const lastUserMsg = getLastUserMessage()
  const lastUserAttachments = lastUserMsg?.attachments && lastUserMsg.attachments.length > 0
    ? lastUserMsg.attachments
    : undefined

  await streamReply(continuePrompt, { reuseLastAssistant: true, isContinue: true, images: lastUserAttachments })
}

/**
 * 复制某条消息内容到剪贴板，并在短时间内提示「已复制」。
 */
const copiedMessageId = ref<number | null>(null)

const copyMessage = async (message: Message) => {
  if (!message.content) {
    return
  }

  try {
    await navigator.clipboard.writeText(message.content)
    copiedMessageId.value = message.id
    setTimeout(() => {
      if (copiedMessageId.value === message.id) {
        copiedMessageId.value = null
      }
    }, 1500)
  } catch (error) {
    console.warn('复制失败:', error)
    ElMessage.error('复制失败，请稍后重试。')
  }
}

/**
 * 重新生成最后一条助手回复。
 * 移除当前最后一条 assistant 消息后，基于最近一次用户输入重新发起流式请求。
 */
async function regenerateLast() {
  if (isStreaming.value) {
    return
  }

  let lastAssistantIndex = -1
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i].role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }

  if (lastAssistantIndex < 0) {
    return
  }

  messages.value.splice(lastAssistantIndex, 1)

  const lastUserMsg = getLastUserMessage()
  const lastUserPrompt = lastUserMsg ? (lastUserMsg.fileContext ? `${lastUserMsg.content}\n\n${lastUserMsg.fileContext}` : lastUserMsg.content) : ''
  if (!lastUserPrompt) {
    void persistSession()
    return
  }

  // 恢复首次发送时携带的图片参数，保证重新生成与首次发送链路一致。
  // 文档提取文本已拼进 prompt，不再单独处理。
  const lastUserAttachments = lastUserMsg?.attachments && lastUserMsg.attachments.length > 0
    ? lastUserMsg.attachments
    : undefined

  void persistSession()
  await streamReply(lastUserPrompt, { images: lastUserAttachments })
}

/**
 * 发送当前输入框内容。
 * 1. 校验非空且未重复提交
 * 2. 追加用户消息
 * 3. 清空输入框并触发流式请求
 */
async function handleSend() {
  if (isSessionLoading.value) {
    return
  }

  const text = input.value.trim()
  if ((!text && attachments.value.length === 0) || isStreaming.value) {
    return
  }

  // 仅附件场景下，补默认提示词以触发流式请求。
  const userText = text || ATTACHMENT_ONLY_PROMPT

  isPaused.value = false

  if (chatTitle.value === '新对话') {
    chatTitle.value = buildSessionTitleByPrompt(userText)
  }

  // 图片转 base64 随流式请求发给后端；文档提取文本拼进 prompt
  const { imageData, files, fileContext } = await processAttachments(attachments.value.map((a) => a.file))

  // 发给后端的 prompt：用户文本 + 文件文本（气泡只展示用户文本，保持干净）
  const sendText = fileContext ? `${userText}\n\n${fileContext}` : userText

  messages.value.push({
    id: nextMessageId(),
    role: 'user',
    content: userText,
    attachments: imageData.length > 0 ? imageData : undefined,
    files: files.length > 0 ? files : undefined,
    fileContext,
  })

  void persistSession()
  input.value = ''

  clearAttachment()
  focusInput()
  scheduleScrollToBottom(true)
  void streamReply(sendText, { images: imageData.length ? imageData : undefined })
}

watch(
  () => route.params.sessionID,
  (newID) => {
    if (!newID) {
      return
    }
    void restoreSession(String(newID))
  },
  { immediate: true },
)

watch(hasConversation, async (visible) => {
  await nextTick()
  updateComposerSafeSpace()
  bindComposerResizeObserver()

  if (visible) {
    scheduleScrollToBottom(true)
  }
  // 会话切换后同步锚点高亮
  syncActiveAnchorByScroll()
})

/**
 * 页面挂载时执行：
 * - 获取后端模型列表
 * - 恢复当前 session
a - 聚焦输入框
 */
/* ============================================================
 *  响应式布局断点诊断器（仅 dev 环境 console.log）
 *  拖动窗口 / 切换分辨率时，会在 DevTools Console 打印：
 *    [ChatView Layout] 档名 | VW x VH | padding/margin 实际值
 *  档名对照表见 CSS <style> 顶部块注释。
 * ============================================================ */
type LayoutTier =
  | '2XL (≥1920, 240px)'
  | 'XL  (1680~1919, 200px)'
  | 'LG  (1440~1679, 160px)'
  | 'MD  (1280~1439, 120px) ← 1366办公屏'
  | 'SM  (1100~1279,  80px)'
  | 'BASE(<1100,       48px)'
  | 'MOB (≤900,        16px)'

function resolveLayoutTier(vw: number): LayoutTier {
  if (vw <= 900) return 'MOB (≤900,        16px)'
  if (vw < 1100) return 'BASE(<1100,       48px)'
  if (vw < 1280) return 'SM  (1100~1279,  80px)'
  if (vw < 1440) return 'MD  (1280~1439, 120px) ← 1366办公屏'
  if (vw < 1680) return 'LG  (1440~1679, 160px)'
  if (vw < 1920) return 'XL  (1680~1919, 200px)'
  return '2XL (≥1920, 240px)'
}

let layoutDiagnoseRaf: number | null = null
let layoutUnbindResize: (() => void) | null = null

function diagnoseLayout(force = false) {
  if (layoutDiagnoseRaf != null) return
  layoutDiagnoseRaf = window.requestAnimationFrame(() => {
    layoutDiagnoseRaf = null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const tier = resolveLayoutTier(vw)
    const layoutEl = chatLayoutRef.value as HTMLElement | null
    const shellEl = document.querySelector<HTMLElement>('.chat-composer-shell')
    const panelEl = document.querySelector<HTMLElement>('.messages-panel')
    const innerEl = document.querySelector<HTMLElement>('.chat-composer-shell-inner')
    const pad = layoutEl ? getComputedStyle(layoutEl).paddingLeft : '?'
    const margin = shellEl ? getComputedStyle(shellEl).marginLeft : '?'
    const panelW = panelEl ? `${Math.round(panelEl.getBoundingClientRect().width)}px` : '?'
    const innerW = innerEl ? `${Math.round(innerEl.getBoundingClientRect().width)}px` : '?'
    // 开发环境才输出，避免生产环境污染 console
    if (force || import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log(
        `%c[ChatView Layout] %c${tier}  %cVW=${vw} VH=${vh}\n` +
          `  chat-layout.padding(L/R) = ${pad} / ${layoutEl ? getComputedStyle(layoutEl).paddingRight : '?'}\n` +
          `  composer-shell.margin(L/R) = ${margin} / ${shellEl ? getComputedStyle(shellEl).marginRight : '?'}\n` +
          `  messages-panel.width=${panelW}  vs  composer-inner.width=${innerW}  (确保 panel ≤ inner)`,
        'color:#2563eb;font-weight:600',
        'color:#4f46e5;font-weight:700',
        'color:#0f172a',
      )
    }
  })
}

onMounted(async () => {
  try {
    /* mode-buttons：第一步先从 sessionStorage 只读恢复 → 再开门禁允许写回，
       避免 watch immediate 把 false 默认值覆盖历史缓存。 */
    if (!modeButtonsHydrated) {
      const stored = loadModeButtons()
      thinkingEnabled.value = stored.thinkingEnabled
      searchEnabled.value = stored.searchEnabled
      modeButtonsHydrated = true
    }

    focusInput()
    await nextTick()
    updateComposerSafeSpace()
    bindComposerResizeObserver()
    scheduleScrollToBottom(true)
    // 消息加载后同步锚点激活态
    syncActiveAnchorByScroll()
    // ---- 布局断点诊断：mounted 立刻打一次，resize 时 rAF 节流再打 ----
    const onResize = () => diagnoseLayout(false)
    window.addEventListener('resize', onResize)
    layoutUnbindResize = () => window.removeEventListener('resize', onResize)
    diagnoseLayout(true)
  } catch (error) {
    console.error(error)
  }
})

onBeforeUnmount(() => {
  if (autoScrollRafId != null) {
    cancelAnimationFrame(autoScrollRafId)
    autoScrollRafId = null
  }
  if (anchorSyncRafId != null) {
    cancelAnimationFrame(anchorSyncRafId)
    anchorSyncRafId = null
  }
  if (layoutDiagnoseRaf != null) {
    cancelAnimationFrame(layoutDiagnoseRaf)
    layoutDiagnoseRaf = null
  }
  layoutUnbindResize?.()
  layoutUnbindResize = null
  composerResizeObserver?.disconnect()
  clearAttachment()
  // 组件卸载前确保最后一次会话快照落库，避免防抖任务被丢弃
  void flushRemoteSnapshot()
})
</script>

<template>
  <main class="workspace">
    <!-- 右侧对话定位锚点：fixed 固定在视口，不随内容滚动 -->
    <div v-if="userMessageAnchors.length > 1" class="chat-anchors">
      <div
        v-for="anchor in userMessageAnchors"
        :key="anchor.id"
        class="anchor-item"
        :class="{
          active: activeAnchorId === anchor.id,
          hovered: hoveredAnchorId === anchor.id,
        }"
        @mouseenter="() => (hoveredAnchorId = anchor.id)"
        @mouseleave="() => (hoveredAnchorId = null)"
        @click="jumpToMessage(anchor.id)"
      >
        <span class="anchor-label">{{ anchor.preview }}</span>
        <span class="anchor-bar"></span>
      </div>
    </div>

    <!-- 有 sessionID 即进入对话视图；历史消息加载中显示 loading -->
    <section ref="chatLayoutRef" class="chat-layout" :style="chatLayoutStyle" @scroll="handleChatLayoutScroll">
      <div class="messages-panel">
        <div v-if="isSessionLoading" class="messages-loading" aria-label="历史对话加载中">
          <div class="skeleton-row user">
            <div class="skeleton-bubble user">
              <span class="skeleton-line w-52" />
            </div>
          </div>
          <div class="skeleton-row assistant">
            <span class="skeleton-badge" />
            <div class="skeleton-bubble assistant">
              <span class="skeleton-line w-48" />
              <span class="skeleton-line w-70" />
              <span class="skeleton-line w-86" />
            </div>
          </div>
          <div class="skeleton-row user">
            <div class="skeleton-bubble user">
              <span class="skeleton-line w-52" />
            </div>
          </div>
          <div class="skeleton-row assistant">
            <span class="skeleton-badge" />
            <div class="skeleton-bubble assistant">
              <span class="skeleton-line w-86" />
              <span class="skeleton-line w-62" />
              <span class="skeleton-line w-40" />
            </div>
          </div>
        </div>
        <template v-else>
          <div
            v-for="message in messages"
            :key="message.id"
            :id="`msg-${message.id}`"
            :class="['message-row', message.role]"
          >
            <div
              :class="[
                'bubble',
                message.role,
                { 'row-flash': message.role === 'user' && flashingMessageId === message.id },
              ]"
            >
              <div v-if="message.role === 'assistant'" class="bubble-meta">
                {{ isStreaming && messages[messages.length - 1]?.id === message.id ? '正在生成…' : 'DeepSeek' }}
              </div>
              <div class="bubble-text">
                <!-- 流式中用纯文本渲染，避免每个 chunk 重跑 markdown 解析导致 UI 卡死 -->
                <div
                  v-if="message.role === 'assistant' && isStreaming && messages[messages.length - 1]?.id === message.id"
                  class="markdown-body streaming-plain"
                >
                  {{ message.content }}<span class="cursor">|</span>
                </div>
                <!-- 流式结束后用 Markdown 渲染，一次性完成解析 -->
                <div
                  v-else-if="message.role === 'assistant'"
                  class="markdown-body"
                  v-html="renderMarkdown(message.content)"
                ></div>
                <template v-else>
                  <div v-if="message.files?.length" class="bubble-files">
                    <div v-for="(file, idx) in message.files" :key="idx" class="bubble-file-card">
                      <span class="bubble-file-icon">{{ getFileTypeTag(file.name) }}</span>
                      <span class="bubble-file-meta">
                        <span class="bubble-file-name">{{ file.name }}</span>
                        <span class="bubble-file-size">{{ formatAttachmentSize(file.size) }}</span>
                      </span>
                    </div>
                  </div>
                  <div v-if="message.attachments?.length" class="bubble-images">
                    <a
                      v-for="(att, idx) in message.attachments"
                      :key="idx"
                      :href="att.url"
                      target="_blank"
                      rel="noreferrer"
                      class="bubble-image-link"
                      @click.prevent="bubbleImagePreviewUrl = att.url"
                    >
                      <img :src="att.url" class="bubble-image" alt="附件图片" />
                    </a>
                  </div>
                  {{ message.content }}
                </template>
              </div>
              <div v-if="message.role === 'assistant' && !isStreaming" class="message-actions">
                <button type="button" class="action-btn" @click="copyMessage(message)">
                  {{ copiedMessageId === message.id ? '已复制' : '复制' }}
                </button>
                <button
                  v-if="messages[messages.length - 1]?.id === message.id && hasConversation"
                  type="button"
                  class="action-btn"
                  @click="regenerateLast"
                >
                  重新生成
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <aside v-if="previewAttachment && isFileAttachment && showFilePreview" class="file-preview-panel">
        <div class="file-preview-header">
          <strong class="file-preview-name">{{ previewAttachment.file.name }}</strong>
          <button type="button" class="file-preview-close" @click="showFilePreview = false">×</button>
        </div>
        <object :data="previewAttachment.url" class="file-preview-object">
          <p>
            当前文件无法直接预览，
            <a :href="previewAttachment.url" target="_blank" rel="noreferrer">点击打开</a>
          </p>
        </object>
      </aside>

    </section>

    <!-- 聊天态输入区固定在 main 下，外层壳体贴底并提供背景遮罩 -->
    <div class="chat-composer-shell">
      <!-- 继续生成按钮：定位在输入框壳体右上方，不被输入框挡住 -->
      <button v-if="showContinueButton" class="continue-button" @click="continueGeneration">继续生成</button>
      <div ref="chatComposerShellInnerRef" class="chat-composer-shell-inner">
        <ComposerPanel
          ref="chatComposerRef"
          v-model="input"
          v-model:attachments="attachments"
          composer-class="chat-composer"
          :thinking-enabled="thinkingEnabled"
          :search-enabled="searchEnabled"
          :send-button-disabled="sendButtonDisabled"
          :send-button-active="sendButtonActive"
          :send-button-loading="sendButtonLoading"
          :send-aria-label="isStreaming ? 'stop' : 'send'"
          :send-tooltip="isStreaming ? '停止生成' : (sendButtonDisabled ? '请输入你的问题' : '')"
          @toggle-thinking="toggleThinking"
          @toggle-search="toggleSearch"
          @open-attachment-preview="openAttachmentPreview"
          @remove-attachment="handleRemoveAttachment"
          @submit="handleSend"
          @send="isStreaming ? stopGeneration() : handleSend()"
        >
          <template #sendContent>
            <svg v-if="isStreaming" class="stop-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/></svg>
            <el-icon v-else><Top /></el-icon>
          </template>
        </ComposerPanel>
        <p class="composer-disclaimer">内容由AI生成，可能不准确，请注意核实</p>
      </div>
    </div>

    <ImagePreviewModal
      :visible="showImagePreview && !!previewAttachment && isImageAttachment"
      :image-url="previewAttachment?.url || ''"
      :image-alt="previewAttachment?.file.name || 'image preview'"
      @close="showImagePreview = false"
    />
    <ImagePreviewModal
      :visible="!!bubbleImagePreviewUrl"
      :image-url="bubbleImagePreviewUrl"
      image-alt="附件图片"
      @close="bubbleImagePreviewUrl = ''"
    />
  </main>
</template>

<style scoped src="../assets/css/ChatView.css"></style>
