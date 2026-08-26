<script setup lang="ts">
import { Close, Top } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { nextTick, onMounted, ref, watch } from 'vue'

type AttachmentItem = {
  file: File
  url: string
}

/* -------------------------------------------------------------------------- */
/*  附件相关常量：统一在此定义，HomeView / ChatView 不再各自重复              */
/* -------------------------------------------------------------------------- */
const MAX_COMPOSER_HEIGHT = 220
// 附件总额：最多 10 个、每个 ≤ 10MB（兼顾可用性与 token 成本）。
const MAX_UPLOAD_FILES = 10
const MAX_UPLOAD_SIZE_MB = 10
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024
// 图片走 DeepSeek 视觉模型（成本高、上游有限制），单独收紧并与后端 chatController.js 对齐：
// 图片最多 5 张（每张大小与总额一致 ≤10MB）。文档不受图片张数限制，仍走总数/总大小校验。
const MAX_IMAGE_FILES = 5
const MAX_IMAGE_SIZE_MB = 10
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024
const UPLOAD_HINT = `仅识别图片和文件中的文字<br>最多 ${MAX_UPLOAD_FILES} 个，每个不超过 ${MAX_UPLOAD_SIZE_MB} MB<br>其中图片最多 ${MAX_IMAGE_FILES} 张`

/**
 * 统一输入区组件入参：
 * - modelValue: 输入文本
 * - attachments: 附件列表（支持多文件）
 * - thinkingEnabled/searchEnabled: 模式按钮状态
 * - sendButton*: 发送按钮状态
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    attachments: AttachmentItem[]
    thinkingEnabled: boolean
    searchEnabled: boolean
    sendButtonDisabled: boolean
    sendButtonActive: boolean
    sendButtonLoading: boolean
    sendAriaLabel?: string
    sendTooltip?: string
    composerClass?: string
  }>(),
  {
    sendAriaLabel: 'send',
    sendTooltip: '',
    composerClass: '',
  },
)

/**
 * 对外事件：
 * - update:attachments：附件列表变更（增删），父组件用 v-model:attachments 接收
 * - 其余事件由父组件接管业务逻辑
 */
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'update:attachments', value: AttachmentItem[]): void
  (e: 'toggleThinking'): void
  (e: 'toggleSearch'): void
  (e: 'openAttachmentPreview', index: number): void
  (e: 'removeAttachment', index: number): void
  (e: 'submit'): void
  (e: 'send'): void
}>()

// 内部 DOM 引用：用于输入框自适应高度与触发原生文件选择。
const inputRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

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
 * 基于扩展名生成文件类型标签，用于文件附件卡片左侧图标文案。
 */
const getFileTypeTag = (name: string) => {
  const lastDot = name.lastIndexOf('.')
  if (lastDot < 0 || lastDot === name.length - 1) {
    return 'FILE'
  }

  return name.slice(lastDot + 1, lastDot + 5).toUpperCase()
}

const isImageAttachment = (file: File) => file.type.startsWith('image/')

/**
 * 文本框自适应：
 * 先回退到 auto，再按内容高度增长，超过阈值后开启滚动。
 */
const resizeComposer = () => {
  const el = inputRef.value
  if (!el) {
    return
  }

  el.style.height = 'auto'
  const nextHeight = Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)
  el.style.height = `${nextHeight}px`
  el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden'
  // 诊断日志：确认高度限制是否生效
  console.log('[resizeComposer]', {
    scrollHeight: el.scrollHeight,
    limit: MAX_COMPOSER_HEIGHT,
    appliedHeight: nextHeight,
    overflow: el.style.overflowY,
    capped: el.scrollHeight > MAX_COMPOSER_HEIGHT,
  })
}

// 供父组件在发送后重新聚焦输入框。
const focusInput = () => {
  inputRef.value?.focus()
}

// 触发隐藏的 file input，保持自定义上传按钮样式。
const openFilePicker = () => {
  fileInputRef.value?.click()
}

/**
 * 文件选择校验：数量、大小均在组件内部完成。
 * 通过 update:attachments 事件通知父组件更新列表。
 */
const handleFileChange = (event: Event) => {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files ?? [])

  if (files.length === 0) {
    return
  }

  if (props.attachments.length + files.length > MAX_UPLOAD_FILES) {
    ElMessage.warning({ dangerouslyUseHTMLString: true, message: UPLOAD_HINT })
    target.value = ''
    return
  }

  const oversizedFile = files.find((file) => file.size > MAX_UPLOAD_SIZE_BYTES)
  if (oversizedFile) {
    ElMessage.warning({ dangerouslyUseHTMLString: true, message: UPLOAD_HINT })
    target.value = ''
    return
  }

  // 图片专属限额（与后端对齐）：最多 5 张、每张 ≤ 10MB。
  // 文档不受此限，仍按上面的总数/总大小校验。
  const currentImageCount = props.attachments.filter((a) => isImageAttachment(a.file)).length
  const selectedImages = files.filter((file) => isImageAttachment(file))
  if (currentImageCount + selectedImages.length > MAX_IMAGE_FILES) {
    ElMessage.warning(`图片最多 ${MAX_IMAGE_FILES} 张，每张不超过 ${MAX_IMAGE_SIZE_MB} MB`)
    target.value = ''
    return
  }

  const oversizedImage = selectedImages.find((file) => file.size > MAX_IMAGE_SIZE_BYTES)
  if (oversizedImage) {
    ElMessage.warning(`图片最多 ${MAX_IMAGE_FILES} 张，每张不超过 ${MAX_IMAGE_SIZE_MB} MB`)
    target.value = ''
    return
  }

  const nextItems = files.map((file) => ({
    file,
    url: URL.createObjectURL(file),
  }))

  emit('update:attachments', [...props.attachments, ...nextItems])

  target.value = ''
}

/**
 * 移除指定附件并同步给父组件。
 */
const handleRemoveAttachment = (index: number) => {
  const next = [...props.attachments]
  const [removed] = next.splice(index, 1)
  if (removed?.url) {
    URL.revokeObjectURL(removed.url)
  }
  emit('update:attachments', next)
  emit('removeAttachment', index)
}

/**
 * 输入同步：
 * - 先向父组件同步 v-model
 * - 再在 nextTick 后重新计算高度，避免量测时机不准
 */
const handleInput = (event: Event) => {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
  nextTick(() => {
    resizeComposer()
  })
}

// Enter 发送，Shift+Enter 换行。
const handleComposerKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    emit('submit')
  }
}

// 外部修改 modelValue（例如发送后清空）时，重新修正输入框高度。
watch(
  () => props.modelValue,
  () => {
    nextTick(() => {
      resizeComposer()
    })
  },
)

// 首次渲染后做一次高度校正。
onMounted(() => {
  resizeComposer()
})

// 暴露给父组件：用于聚焦与手动刷新高度。
defineExpose({
  focusInput,
  resizeComposer,
})
</script>

<template>
  <div class="composer-box" :class="composerClass">
    <!-- 附件区：图片显示缩略图，文件显示类型/名称/大小 -->
    <div v-if="attachments.length" class="attachment-row">
      <div
        v-for="(attachment, index) in attachments"
        :key="`${attachment.file.name}-${attachment.file.size}-${index}`"
        class="attachment-card"
        :class="isImageAttachment(attachment.file) ? 'is-image' : 'is-file'"
        @click="emit('openAttachmentPreview', index)"
      >
        <template v-if="isImageAttachment(attachment.file)">
          <img class="attachment-image" :src="attachment.url" :alt="attachment.file.name" />
        </template>
        <template v-else>
          <span class="attachment-file-icon">{{ getFileTypeTag(attachment.file.name) }}</span>
          <span class="attachment-meta">
            <span class="attachment-name">{{ attachment.file.name }}</span>
            <span class="attachment-size">{{ formatAttachmentSize(attachment.file.size) }}</span>
          </span>
        </template>
        <button class="attachment-remove" type="button" aria-label="remove attachment" @click.stop="handleRemoveAttachment(index)">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>

    <textarea
      ref="inputRef"
      :value="modelValue"
      class="composer-input"
      rows="1"
      placeholder="有问题，尽管问，shift + enter 换行"
      @keydown="handleComposerKeydown"
      @input="handleInput"
    />

    <!-- 底部操作区：模式按钮 + 上传 + 发送 -->
    <div class="composer-footer">
      <div class="mode-buttons">
        <button class="mode-btn thinking-btn" :class="{ selected: thinkingEnabled }" type="button" @click="emit('toggleThinking')">
          <span class="mode-icon"
            ><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16" width="16" height="16" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; transform: translate3d(0px, 0px, 0px); content-visibility: visible;"><defs><clipPath id="composer_thinking_icon"><rect width="16" height="16" x="0" y="0"></rect></clipPath></defs><g clip-path="url(#composer_thinking_icon)"><g transform="matrix(0.9728225469589233,0,0,0.9728225469589233,0.21741962432861328,0.21741962432861328)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path fill="rgb(15,17,20)" fill-opacity="1" d=" M8,6.769999980926514 C8.678836822509766,6.769999980926514 9.229999542236328,7.321163177490234 9.229999542236328,8 C9.229999542236328,8.678836822509766 8.678836822509766,9.229999542236328 8,9.229999542236328 C7.321163177490234,9.229999542236328 6.769999980926514,8.678836822509766 6.769999980926514,8 C6.769999980926514,7.321163177490234 7.321163177490234,6.769999980926514 8,6.769999980926514z"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M10.310430526733398,10.310430526733398 C7.105431079864502,13.51543140411377 3.4737708568573,15.077771186828613 2.197999954223633,13.802000045776367 C0.9222292304039001,12.526228904724121 2.485476493835449,8.89450740814209 5.690476417541504,5.689507484436035 C8.895476341247559,2.4845073223114014 12.526228904724121,0.9222292304039001 13.802000045776367,2.197999954223633 C15.077771186828613,3.4737708568573 13.51543140411377,7.105431079864502 10.310430526733398,10.310430526733398z"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M10.730999946594238,5.269000053405762 C13.935999870300293,8.473999977111816 15.3100004196167,12.293999671936035 13.802000045776367,13.802000045776367 C12.293999671936035,15.3100004196167 8.475000381469727,13.935999870300293 5.269999980926514,10.730999946594238 C2.065000057220459,7.526000022888184 0.6899999976158142,3.7060000896453857 2.197999954223633,2.197999954223633 C3.7060000896453857,0.6899999976158142 7.526000022888184,2.063999891281128 10.730999946594238,5.269000053405762z"></path></g></g></g></svg></span
          >
          <span class="mode-label">深度思考</span>
        </button>
        <button class="mode-btn search-btn" :class="{ selected: searchEnabled }" type="button" @click="emit('toggleSearch')">
          <span class="mode-icon">
            <svg class="search-icon-off" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16" width="16" height="16" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; transform: translate3d(0px, 0px, 0px); content-visibility: visible;"><defs><clipPath id="composer_search_icon"><rect width="16" height="16" x="0" y="0"></rect></clipPath></defs><g clip-path="url(#composer_search_icon)"><g style="display: block;" transform="matrix(1,0,0,1,0,0)" opacity="1"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,14.849200248718262 C9.598299980163574,14.849200248718262 10.894100189208984,11.78279972076416 10.894100189208984,8 C10.894100189208984,4.217199802398682 9.598299980163574,1.1509000062942505 7.999599933624268,1.1509000062942505"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,14.849200248718262 C6.400899887084961,14.849200248718262 5.105000019073486,11.78279972076416 5.105000019073486,8 C5.105000019073486,4.217199802398682 6.400899887084961,1.1509000062942505 7.999599933624268,1.1509000062942505"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="0.4530976080316355" style="display: none;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,14.849200248718262 C4.216800212860107,14.849200248718262 1.1504000425338745,11.78279972076416 1.1504000425338745,8 C1.1504000425338745,4.217199802398682 4.216800212860107,1.1509000062942505 7.999599933624268,1.1509000062942505"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,1.1509000062942505 C11.782400131225586,1.1509000062942505 14.848699569702148,4.217199802398682 14.848699569702148,8 C14.848699569702148,11.78279972076416 11.782400131225586,14.849200248718262 7.999599933624268,14.849200248718262 C4.216800212860107,14.849200248718262 1.1504000425338745,11.78279972076416 1.1504000425338745,8 C1.1504000425338745,4.217199802398682 4.216800212860107,1.1509000062942505 7.999599933624268,1.1509000062942505z"></path></g><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M1.6399999856948853,8 C1.6399999856948853,8 14.359999656677246,8 14.359999656677246,8"></path></g></g></g></svg>
            <svg class="search-icon-on" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16" width="16" height="16" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; transform: translate3d(0px, 0px, 0px); content-visibility: visible;"><defs><clipPath id="composer_search_icon_on"><rect width="16" height="16" x="0" y="0"></rect></clipPath></defs><g clip-path="url(#composer_search_icon_on)"><g style="display: block;" transform="matrix(1,0,0,1,0,0)" opacity="1"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,14.849200248718262 C11.782400131225586,14.849200248718262 14.848699569702148,11.78279972076416 14.848699569702148,8 C14.848699569702148,4.217199802398682 11.782400131225586,1.1509000062942505 7.999599933624268,1.1509000062942505"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,14.849200248718262 C9.594799995422363,14.849200248718262 10.887849807739258,11.78279972076416 10.887849807739258,8 C10.887849807739258,4.217199802398682 9.594799995422363,1.1509000062942505 7.999599933624268,1.1509000062942505"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,14.849200248718262 C6.396399974822998,14.849200248718262 5.0968499183654785,11.78279972076416 5.0968499183654785,8 C5.0968499183654785,4.217199802398682 6.396399974822998,1.1509000062942505 7.999599933624268,1.1509000062942505"></path></g></g><g transform="matrix(1,0,0,1,0,0)" opacity="1" style="display: block;"><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M7.999599933624268,1.1509000062942505 C11.782400131225586,1.1509000062942505 14.848699569702148,4.217199802398682 14.848699569702148,8 C14.848699569702148,11.78279972076416 11.782400131225586,14.849200248718262 7.999599933624268,14.849200248718262 C4.216800212860107,14.849200248718262 1.1504000425338745,11.78279972076416 1.1504000425338745,8 C1.1504000425338745,4.217199802398682 4.216800212860107,1.1509000062942505 7.999599933624268,1.1509000062942505z"></path></g><g opacity="1" transform="matrix(1,0,0,1,0,0)"><path stroke-linecap="round" stroke-linejoin="round" fill-opacity="0" stroke="rgb(15,17,20)" stroke-opacity="1" stroke-width="1.4" d=" M1.6399999856948853,8 C1.6399999856948853,8 14.359999656677246,8 14.359999656677246,8"></path></g></g></g></svg>
          </span>
          <span class="mode-label">智能搜索</span>
        </button>
      </div>

      <div class="composer-tools">
        <!-- 隐藏原生 file input，通过自定义按钮触发 -->
        <input
          ref="fileInputRef"
          class="file-input"
          type="file"
          multiple
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.css,.scss,.less,.yml,.yaml,.js,.mjs,.cjs,.ts,.tsx,.jsx,.vue,.py,.java,.go,.rs,.c,.h,.cpp,.hpp,.cc,.cs,.rb,.php,.sh,.bash,.sql,.ini,.conf,.toml,.log"
          @change="handleFileChange"
        />
        <el-tooltip raw-content :content="UPLOAD_HINT" placement="top" :show-after="300">
          <button class="tool-button" type="button" aria-label="upload" @click="openFilePicker">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5498 9.75V5H6.9502V9.75C6.9502 10.3299 7.4201 10.7998 8 10.7998C8.5799 10.7998 9.0498 10.3299 9.0498 9.75V4.5C9.0498 2.9536 7.7964 1.7002 6.25 1.7002C4.7036 1.7002 3.4502 2.9536 3.4502 4.5V9.75C3.4502 12.2629 5.4871 14.2998 8 14.2998C10.5129 14.2998 12.5498 12.2629 12.5498 9.75V4H13.9502V9.75C13.9502 13.0361 11.2861 15.7002 8 15.7002C4.71391 15.7002 2.0498 13.0361 2.0498 9.75V4.5C2.04981 2.1804 3.9304 0.299806 6.25 0.299805C8.5696 0.299805 10.4502 2.1804 10.4502 4.5V9.75C10.4502 11.1031 9.3531 12.2002 8 12.2002C6.6469 12.2002 5.5498 11.1031 5.5498 9.75Z" fill="currentColor"></path></svg>
          </button>
        </el-tooltip>
        <el-tooltip
          :content="sendTooltip"
          :disabled="!sendTooltip"
          placement="top"
          :show-after="300"
        >
          <button
            class="send-button"
            :class="{ active: sendButtonActive, loading: sendButtonLoading, disabled: sendButtonDisabled }"
            :disabled="sendButtonDisabled"
            :aria-label="sendAriaLabel"
            @click="emit('send')"
          >
            <slot name="sendContent">
              <el-icon><Top /></el-icon>
            </slot>
          </button>
        </el-tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer-box {
  width: min(760px, 100%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  background: rgba(255, 255, 255, 0.68);
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 20px;
  padding: 12px;
  box-shadow: 0 16px 30px rgba(15, 23, 42, 0.04);
}

.attachment-row {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}

.attachment-card {
  position: relative;
  cursor: pointer;
}

.attachment-card.is-image {
  width: 64px;
  height: 64px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: #fff;
  border-radius: 10px;
  overflow: hidden;
}

.attachment-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.attachment-card.is-file {
  width: min(220px, 100%);
  height: 64px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(255, 255, 255, 0.92);
  border-radius: 10px;
  padding: 8px 10px;
  text-align: left;
  overflow: hidden;
  transition: background 0.15s ease;
}

.attachment-card.is-file:hover {
  background: rgba(241, 245, 249, 0.96);
}

.attachment-file-icon {
  min-width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.12);
  color: #1d4ed8;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.attachment-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.attachment-name {
  font-size: 0.8rem;
  color: #0f172a;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  max-width: 140px;
}

.attachment-size {
  font-size: 0.7rem;
  color: #64748b;
}

.attachment-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.62);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, background 0.2s ease;
}

.attachment-card:hover .attachment-remove {
  opacity: 1;
  pointer-events: auto;
}

.attachment-remove:hover {
  background: rgba(15, 23, 42, 0.78);
}

.composer-input {
  min-height: 52px;
  max-height: 220px;
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: #0f172a;
  font: inherit;
  font-size: 1.03rem;
  line-height: 1.7;
  padding: 0;
  overflow-y: hidden;
}

.composer-input::placeholder {
  color: rgba(15, 23, 42, 0.42);
}

.composer-tools {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}

.composer-footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mode-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(37, 99, 235, 0.24);
  background: rgba(255, 255, 255, 0.86);
  color: #0f172a;
  font-size: 0.85rem;
  font-weight: 400;
  transition: all 0.2s ease;
}

.mode-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  line-height: 0;
  flex-shrink: 0;
}

.mode-btn svg {
  width: 16px;
  height: 16px;
  color: currentColor;
  display: block;
  transform-origin: center center;
  transform-box: fill-box;
}

.mode-btn svg path {
  stroke: currentColor !important;
  fill: currentColor !important;
}

.mode-btn.search-btn .mode-icon {
  position: relative;
  overflow: hidden;
}

.mode-btn.search-btn .mode-icon > .search-icon-off,
.mode-btn.search-btn .mode-icon > .search-icon-on {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transition: opacity 0.4s cubic-bezier(0.22, 0.72, 0.2, 1), transform 0.4s cubic-bezier(0.22, 0.72, 0.2, 1);
}

.mode-btn.search-btn .mode-icon > .search-icon-off {
  opacity: 1;
  transform: translateX(0);
}

.mode-btn.search-btn .mode-icon > .search-icon-on {
  opacity: 0;
  transform: translateX(-2px);
}

.mode-btn.search-btn.selected .mode-icon > .search-icon-off {
  opacity: 0;
  transform: translateX(2px);
}

.mode-btn.search-btn.selected .mode-icon > .search-icon-on {
  opacity: 1;
  transform: translateX(0);
}

.mode-btn:hover {
  background: rgba(219, 234, 254, 0.72);
}

.mode-btn.selected {
  background: linear-gradient(180deg, rgba(191, 219, 254, 0.7), rgba(147, 197, 253, 0.54));
  border-color: rgba(37, 99, 235, 0.44);
  color: #2563eb;
  font-weight: 400;
}

.file-input {
  display: none;
}

.tool-button,
.send-button {
  width: 38px;
  height: 38px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #eef4ff;
  color: #1d4ed8;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 1.1rem;
  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease, background 0.2s ease;
}

.tool-button {
  border: none;
  background: rgba(255, 255, 255, 0.9);
  color: #000;
}

.tool-button:hover {
  background: rgba(219, 234, 254, 0.55);
}

.send-button {
  background: linear-gradient(135deg, #8ab7ff, #5b8cff);
  color: white;
  box-shadow: 0 10px 18px rgba(91, 140, 255, 0.3);
  border: none;
}

.send-button.active {
  transform: translateY(-1px);
}

.send-button.loading {
  cursor: wait;
  box-shadow: 0 0 0 3px rgba(91, 140, 255, 0.18), 0 10px 18px rgba(91, 140, 255, 0.24);
}

.send-button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.mode-label {
  line-height: 1;
}
</style>
