<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  visible: boolean
  imageUrl: string
  imageAlt?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const MIN_ZOOM = 0.2
const MAX_ZOOM = 8

const zoom = ref(1)
const baseWidth = ref(0)
const baseHeight = ref(0)
const panX = ref(0)
const panY = ref(0)

/* 拖拽状态 */
const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
const panStartX = ref(0)
const panStartY = ref(0)

const imageStyle = computed(() => ({
  width: baseWidth.value ? `${baseWidth.value}px` : undefined,
  height: baseHeight.value ? `${baseHeight.value}px` : undefined,
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${zoom.value})`,
  cursor: zoom.value > 1 ? (isDragging.value ? 'grabbing' : 'grab') : 'zoom-in',
}))

const reset = () => {
  zoom.value = 1
  baseWidth.value = 0
  baseHeight.value = 0
  panX.value = 0
  panY.value = 0
}

const close = () => emit('close')

/**
 * 图片加载后按视口计算初始尺寸。
 */
const handleLoad = (event: Event) => {
  const target = event.target as HTMLImageElement
  const nw = target.naturalWidth || target.width
  const nh = target.naturalHeight || target.height

  if (!nw || !nh) {
    reset()
    return
  }

  const maxW = window.innerWidth * 0.9
  const maxH = window.innerHeight * 0.85
  const fit = Math.min(maxW / nw, maxH / nh, 1)

  baseWidth.value = nw * fit
  baseHeight.value = nh * fit
  zoom.value = 1
  panX.value = 0
  panY.value = 0
}

const clampZoom = (v: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v))

const onWheel = (event: WheelEvent) => {
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.15 : 0.15
  zoom.value = clampZoom(zoom.value + delta * zoom.value)
}

const onImageClick = () => {
  if (zoom.value >= MAX_ZOOM - 0.01) {
    zoom.value = 1
    panX.value = 0
    panY.value = 0
    return
  }
  zoom.value = clampZoom(zoom.value + 0.5)
}

/* 拖拽：在 mask 上监听 mousemove/mouseup，避免移出 img 后丢失 */
const onDragStart = (event: MouseEvent) => {
  if (zoom.value <= 1) return
  isDragging.value = true
  dragStartX.value = event.clientX
  dragStartY.value = event.clientY
  panStartX.value = panX.value
  panStartY.value = panY.value
}

const onDragMove = (event: MouseEvent) => {
  if (!isDragging.value) return
  panX.value = panStartX.value + (event.clientX - dragStartX.value)
  panY.value = panStartY.value + (event.clientY - dragStartY.value)
}

const onDragEnd = () => {
  isDragging.value = false
}

watch(() => props.visible, (v) => { if (!v) reset() })
watch(() => props.imageUrl, () => reset())
</script>

<template>
  <div v-if="visible" class="image-preview-mask" @click="close" @wheel.prevent="onWheel"
       @mousedown="onDragStart" @mousemove="onDragMove" @mouseup="onDragEnd" @mouseleave="onDragEnd">
    <button class="image-preview-close" type="button" aria-label="close" @click.stop="close">×</button>
    <img
      :src="imageUrl"
      :alt="imageAlt || 'image preview'"
      :style="imageStyle"
      @load="handleLoad"
      @click.stop="onImageClick"
      @dragstart.prevent
    />
  </div>
</template>

<style scoped>
.image-preview-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.72);
  display: grid;
  place-items: center;
  overflow: hidden;
  z-index: 9999;
}

.image-preview-mask img {
  display: block;
  max-width: none;
  max-height: none;
  transform-origin: center center;
  transition: transform 0.05s linear;
  user-select: none;
  -webkit-user-drag: none;
}

.image-preview-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
  font-size: 1.3rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 10;
  transition: background 0.15s ease;
}

.image-preview-close:hover {
  background: rgba(255, 255, 255, 0.35);
}
</style>
