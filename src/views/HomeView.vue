<script setup lang="ts">
import { Top } from '@element-plus/icons-vue'
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import ComposerPanel from '../components/ComposerPanel.vue'
import ImagePreviewModal from '../components/ImagePreviewModal.vue'
import { createSession, ensureDeviceToken } from '../api/chatApi'
import { useModelStore } from '../store/modelStore'
import { buildSessionTitleByPrompt, createSessionId, saveSession, setPendingAttachments } from '../store/sessionStore'

type AttachmentItem = {
  file: File
  url: string
}

/**
 * 首页只负责创建新的会话并跳转到聊天页。
 * 模型选择和通用头部已经抽离到布局层组件中，保证复用性和清晰结构。
 */
const router = useRouter()
const modelStore = useModelStore()
const input = ref('')
const isSubmitting = ref(false)
const composerRef = ref<InstanceType<typeof ComposerPanel> | null>(null)
const attachments = ref<AttachmentItem[]>([])
const previewAttachmentIndex = ref<number | null>(null)
const showImagePreview = ref(false)
const thinkingEnabled = ref(false)
const searchEnabled = ref(false)
const ATTACHMENT_ONLY_PROMPT = '请结合我上传的附件内容进行分析。'

/**
 * 当前预览附件是否为图片类型。
 */
const previewAttachment = computed(() => {
  if (previewAttachmentIndex.value == null) {
    return null
  }

  return attachments.value[previewAttachmentIndex.value] ?? null
})

const isImageAttachment = computed(() => !!previewAttachment.value?.file.type.startsWith('image/'))

const closeImagePreview = () => {
  showImagePreview.value = false
}

/**
 * 输入框中是否存在可发送的文本内容。
 */
const hasInput = () => input.value.trim().length > 0

/**
 * 有文字或有附件都允许发送。
 */
const canSend = () => hasInput() || attachments.value.length > 0

const clearAttachment = () => {
  for (const item of attachments.value) {
    URL.revokeObjectURL(item.url)
  }
  attachments.value = []
  previewAttachmentIndex.value = null
  showImagePreview.value = false
}

/**
 * 附件移除后的联动处理：ComposerPanel 已负责 splice + revokeObjectURL，
 * 父组件只需修正预览索引与图片预览弹窗状态。
 */
const handleRemoveAttachment = (index: number) => {
  if (previewAttachmentIndex.value == null) {
    return
  }

  if (attachments.value.length === 0) {
    previewAttachmentIndex.value = null
    showImagePreview.value = false
    return
  }

  if (previewAttachmentIndex.value === index) {
    previewAttachmentIndex.value = Math.min(index, attachments.value.length - 1)
    const current = attachments.value[previewAttachmentIndex.value]
    showImagePreview.value = !!current?.file.type.startsWith('image/')
    return
  }

  if (previewAttachmentIndex.value > index) {
    previewAttachmentIndex.value -= 1
  }
}

/**
 * 切换"深度思考"开关。
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
 * 打开附件预览：图片弹窗，文件新窗口打开。
 */
const openAttachmentPreview = (index: number) => {
  const target = attachments.value[index]
  if (!target) {
    return
  }

  previewAttachmentIndex.value = index

  if (target.file.type.startsWith('image/')) {
    showImagePreview.value = true
    return
  }

  window.open(target.url, '_blank')
}

/**
 * 创建会话并跳转到 /chat/:sessionID 页面。
 * 这里会保存当前模型和初始用户消息，确保对话页能够正确恢复上下文。
 */
const goToNewChat = async () => {
  if (isSubmitting.value) {
    return
  }

  const text = input.value.trim()
  if (!text && attachments.value.length === 0) {
    return
  }

  // 仅附件场景下，补一个默认提示词，保证可触发后端请求。
  const promptText = text || ATTACHMENT_ONLY_PROMPT

  isSubmitting.value = true

  const sessionID = createSessionId()
  const nextTitle = buildSessionTitleByPrompt(promptText)
  const nextModelId = modelStore.selectedModel || 'deepseek-v3'

  saveSession({
    id: sessionID,
    title: nextTitle,
    modelId: nextModelId,
    thinkingEnabled: thinkingEnabled.value,
    searchEnabled: searchEnabled.value,
    messages: [],
  })

  input.value = ''
  await nextTick()
  composerRef.value?.resizeComposer()

  // 暂存附件到内存，聊天页恢复会话时取出处理（路由 query 无法承载 File/图片）
  if (attachments.value.length > 0) {
    setPendingAttachments(sessionID, attachments.value.map((a) => a.file))
  }

  try {
    await ensureDeviceToken()
    await createSession({
      id: sessionID,
      title: nextTitle,
      modelId: nextModelId,
      thinkingEnabled: thinkingEnabled.value,
      searchEnabled: searchEnabled.value,
      messages: [],
    })

    await router.push({
      name: 'chat',
      params: { sessionID },
      query: {
        prompt: promptText,
        thinking_enabled: String(thinkingEnabled.value),
        search_enabled: String(searchEnabled.value),
      },
    })
  } catch (error) {
    console.error(error)
    window.alert('创建会话失败，请稍后重试。')
  } finally {
    isSubmitting.value = false
  }
}

onBeforeUnmount(() => {
  clearAttachment()
})
</script>

<template>
  <main class="workspace">
    <!-- 空状态欢迎区域：用户未开始对话前，展示入口和输入框 -->
    <section class="empty-state">
      <div class="welcome-panel">
        <div class="welcome-title-wrap">
          <img class="welcome-logo" src="/favicon.svg" alt="元启" />
          <h2>你好，我是元启</h2>
        </div>

        <!-- 主要输入框：用户输入问题后可直接创建新会话 -->
        <ComposerPanel
          ref="composerRef"
          v-model="input"
          v-model:attachments="attachments"
          composer-class="empty-composer"
          :thinking-enabled="thinkingEnabled"
          :search-enabled="searchEnabled"
          :send-button-disabled="!canSend() || isSubmitting"
          :send-button-active="canSend()"
          :send-button-loading="isSubmitting"
          send-aria-label="send"
          :send-tooltip="!canSend() && !isSubmitting ? '请输入你的问题' : ''"
          @toggle-thinking="toggleThinking"
          @toggle-search="toggleSearch"
          @open-attachment-preview="openAttachmentPreview"
          @remove-attachment="handleRemoveAttachment"
          @submit="goToNewChat"
          @send="goToNewChat"
        >
          <template #sendContent>
            <el-icon v-if="!isSubmitting"><Top /></el-icon>
            <span v-else class="button-loader" />
          </template>
        </ComposerPanel>
      </div>
    </section>

    <ImagePreviewModal
      :visible="showImagePreview && !!previewAttachment && isImageAttachment"
      :image-url="previewAttachment?.url || ''"
      :image-alt="previewAttachment?.file.name || 'image preview'"
      @close="closeImagePreview"
    />
  </main>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: #f3f5f7;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 24px 70px;
}

.welcome-panel {
  width: min(760px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 42px;
}

.welcome-title-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #111827;
}

.welcome-logo {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(72, 110, 255, 0.18);
}

.welcome-title-wrap h2 {
  margin: 0;
  font-size: clamp(2rem, 2vw, 2.2rem);
  font-weight: 700;
  letter-spacing: -0.06em;
}

.empty-composer {
  min-height: 120px;
}

.button-loader {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.42);
  border-top-color: #ffffff;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .welcome-panel {
    width: 100%;
  }
}
</style>
